// GenieACS extension (installed as /opt/genieacs/ext/ispman.js): asks ISPMan,
// on this same server, what one ONU should have inside it.
//
// Called from the "ispman" provision as ext("ispman", "config", serial, model, deviceId).
// ISPMan answers only with ISPMAN_ACS_SECRET, and only about that serial.
// Any failure answers { ok: false }, which the provision treats as "change
// nothing" — an ISPMan restart must never touch a customer's Wi-Fi.

const http = require('http')

exports.config = function (args, callback) {
  const q = new URLSearchParams({
    serial: String(args[0] || ''),
    model: String(args[1] || ''),
    device: String(args[2] || ''),
  })
  let answered = false
  const done = (value) => {
    if (answered) return
    answered = true
    callback(null, value)
  }
  const req = http.get(
    {
      host: '127.0.0.1',
      port: Number(process.env.ISPMAN_PORT || 3000),
      path: '/api/acs/config?' + q.toString(),
      headers: { 'x-ispman-acs': process.env.ISPMAN_ACS_SECRET || '' },
      timeout: 8000,
    },
    (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        try {
          done(JSON.parse(body))
        } catch (e) {
          done({ ok: false })
        }
      })
    }
  )
  req.on('timeout', () => req.destroy())
  req.on('error', () => done({ ok: false }))
}
