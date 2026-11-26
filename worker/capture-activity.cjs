const { performance } = require('node:perf_hooks')

const speedWindow = 3000
const entryLimit = 80

function captureActivity(clock = () => performance.now()) {
  const started = clock()
  const samples = []
  const events = []
  let omitted = 0
  let id = 0

  function prune(now) {
    while (samples.length && samples[0].time <= now - speedWindow) samples.shift()
  }

  return {
    saved(bytes) {
      const now = clock()
      prune(now)
      const latest = samples.at(-1)
      // Write bursts in the same 100 ms bucket only need one sample.
      const bucket = Math.floor((now - started) / 100)
      if (latest?.bucket === bucket) {
        latest.bytes += bytes
      } else {
        samples.push({ time: now, bucket, bytes })
      }
    },

    record(kind, label, url, detail = '', bytes) {
      if (events.length === entryLimit) {
        events.shift()
        omitted++
      }
      events.push({ id: ++id, kind, label, url, detail, bytes, elapsedMs: Math.floor(clock() - started) })
    },

    snapshot() {
      const now = clock()
      prune(now)
      const elapsedMs = Math.floor(now - started)
      const seconds = Math.min(speedWindow, Math.max(500, elapsedMs)) / 1000
      const bytesPerSecond = Math.round(samples.reduce((total, sample) => total + sample.bytes, 0) / seconds)
      const batch = { elapsedMs, bytesPerSecond, entries: events.splice(0), omitted }
      omitted = 0
      return batch
    },
  }
}

module.exports = { captureActivity }
