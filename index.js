module.exports = MiddlewareBase => class Rewrite extends MiddlewareBase {
  description () {
    return 'URL Rewriting. Re-route requests to local or remote destinations.'
  }
  optionDefinitions () {
    return [
      {
        name: 'rewrite',
        alias: 'r',
        type: String,
        multiple: true,
        typeLabel: '[underline]{expression} ...',
        description: "A list of URL rewrite rules. For each rule, separate the 'from' and 'to' routes with '->'. Whitespace surrounded the routes is ignored. E.g. '/from -> /to'."
      }
    ]
  }
  middleware (options) {
    const url = require('url')
    const arrayify = require('array-back')
    const routes = parseRewriteRules(arrayify(options.rewrite))

    /* re-use proxy sockets using keep-alive  */
    const http = require('http')
    http.globalAgent = new http.Agent({ keepAlive: true })
    const https = require('https')
    https.globalAgent = new https.Agent({ keepAlive: true })

    if (routes.length) {
      this.emit('verbose', 'middleware.rewrite.config', { rewrite: routes })
      return routes.map(route => {
        if (route.to) {
          /* `to` address is remote if the url specifies a host */
          if (url.parse(route.to).host) {
            const _ = require('koa-route')
            return _.all(route.from, proxyRequest(route, this))
          } else {
            const rewrite = require('koa-rewrite')
            const rmw = rewrite(route.from, route.to)
            return rmw
          }
        }
      })
    }
  }
}

function parseRewriteRules (rules) {
  const t = require('typical')
  return rules && rules.map(rule => {
    if (t.isString(rule)) {
      const matches = rule.match(/(\S*)\s*->\s*(\S*)/)
      if (!(matches && matches.length >= 3)) throw new Error('Invalid rule: ' + rule)
      return {
        from: matches[1],
        to: matches[2]
      }
    } else {
      return rule
    }
  })
}

function proxyRequest (route, mw) {
  const pathToRegexp = require('path-to-regexp')
  const url = require('url')
  let id = 1

  return function proxyMiddleware () {
    const ctx = this
    ctx.state.id = id++
    mw.emit('verbose', 'middleware.rewrite.incoming.request', { id: ctx.state.id, request: ctx.request })
    /* build the remote URL using the 'to' address and route param values */
    const keys = []
    const routeRe = pathToRegexp(route.from, keys)
    let remoteUrl = ctx.url.replace(routeRe, route.to)
    keys.forEach((key, index) => {
      const re = RegExp(`:${key.name}`, 'g')
      remoteUrl = remoteUrl.replace(re, arguments[index + 1] || '')
    })

    /* copy incoming request method and headers to the proxy request */
    const proxyReq = Object.assign(url.parse(remoteUrl), {
      method: ctx.request.method,
      headers: ctx.request.headers,
      /* ignore CA verification imperfections by default */
      rejectUnauthorized: false
    })

    /* proxy request alterations */
    proxyReq.headers.host = proxyReq.host

    return new Promise(async (resolve, reject) => {
      const streamReadAll = require('stream-read-all')
      const reqData = await streamReadAll(ctx.req)
      try {
        mw.emit('verbose', 'middleware.rewrite.proxy.request', { id: ctx.state.id, req: proxyReq, data: reqData.toString() })
        const request = require('req-then')
        const response = await request(proxyReq, reqData)
        const viewResponse = Object.assign({}, response)
        viewResponse.data = viewResponse.data.toString()
        /* if JSON was returned, parse it */
        try {
          viewResponse.data = JSON.parse(viewResponse.data)
        } catch (err) {}
        mw.emit('verbose', 'middleware.rewrite.proxy.response', { id: ctx.state.id, res: viewResponse.res, data: viewResponse.data })
        ctx.status = response.res.statusCode
        ctx.body = response.data
        ctx.set(response.res.headers)
        resolve()
      } catch (err) {
        reject(err)
      }
    })
  }
}
