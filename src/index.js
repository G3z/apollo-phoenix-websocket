import {clone, pipeP, map} from 'ramda'
import {printRequest} from 'apollo-client/transport/networkInterface'
import {Socket as PhoenixSocket} from 'phoenix';

function applyWares (ctx, wares) {
  return new Promise(function (resolve, reject) {
    const queue = function (funcs, scope) {
      const next = function () {
        if (funcs.length > 0) {
          const f = funcs.shift()
          f && (f.applyMiddleware || f.applyAfterware).apply(scope, [ctx, next])
        }
        else {
          resolve(ctx)
        }
      }
      next()
    }
    queue(wares.slice())
  })
}

function executeQuery(sockets, context) {
  const {request, options} = context
  const {uri, channel} = options
  const Socket = options.Socket || PhoenixSocket

  if (! uri) throw "Missing options.uri"
  if (! channel) throw "Missing options.channel"
  if (! channel.topic) throw "Missing options.channel.topic"

  if (options.logger === true) {
    options.logger = (kind, msg, data) =>
      console.log(`Apollo websocket ${kind}: ${msg}`, data)
  }

  if(! sockets[uri]) {
    if (typeof Socket.constructor === 'function') {
      sockets[uri] = {
        conn: new Socket(uri, options),
        channels: {}
      }
    }
    else {
      sockets[uri] = {
        conn: Socket(),
        channels: {}
      }
    }
  }

  const socket = sockets[uri]
  let chan = socket.channels[channel.topic]

  function joinChannel(resolve) {
    if (! socket.conn.isConnected()) {
      return socket.conn.connect()
    }
    if (! chan.conn) {
      chan.conn = socket.conn.channel(channel.topic, channel.params || {})
    }
    if (!chan.conn.isJoined() && !chan.conn.isJoining()) {
      chan.conn.join().receive("ok", _ => {
        const queue = chan.queue
        chan.queue = []
        map(performQuery, queue)
      }).receive('error', err => {
        chan.conn.leave()
        chan.conn = null
        chan.queue.pop()
        resolve(err)
      })
    }
  }


  function performQuery ({context, resolve, reject}) {
    const msg = context.options.channel.in_msg || "gql"
    const payload = printRequest(context.request)
    chan.conn.push(msg, payload)
      .receive("ok", resolve)
      .receive("error", resolve)
      .receive("timeout", reject.bind(null, 'timeout'))
  }

  return new Promise(function (resolve, reject) {
    if(! chan) {
      chan = socket.channels[channel.topic] = {
        conn: null,
        queue: []
      }
      socket.conn.onOpen(joinChannel.bind(null, resolve))
      socket.conn.onError(err => {
        if (chan.conn && (chan.conn.isJoined() || chan.conn.isJoining())) {
          chan.conn.leave()
        }
        chan.queue = []
        resolve(err)
      })
    }
    if (chan.conn && chan.conn.isJoined()) {
      performQuery({context, resolve, reject})
    } else {
      chan.queue.push({context, resolve, reject})
      joinChannel(resolve)
    }
  })
}

const responseData = ({response}) => {
  return new Promise(function (resolve, reject) {
    if (response.error){
      reject(response)
    } else if (response.data) {
      resolve(response)
    } else {
      reject('No response')
    }
  })
}

export function createNetworkInterface(ifaceOpts) {
  const sockets = {}
  const middlewares = []
  const afterwares = []

  const use = map(item => middlewares.push(item))
  const useAfter = map(item => afterwares.push(item))

  const requestMiddleware = (request) => {
    const options = clone(ifaceOpts)
    return applyWares({request, options}, middlewares)
  }

  const responseMiddleware = (response) => {
    const options = clone(ifaceOpts)
    return applyWares({response, options}, afterwares)
  }

  const query = pipeP(requestMiddleware,
                      executeQuery.bind(null, sockets),
                      responseMiddleware,
                      responseData)

  return {query, use, useAfter}
}
