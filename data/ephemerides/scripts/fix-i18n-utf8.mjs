import fs from 'node:fs'
const p = 'D:/项目/Openspace Safety/web/src/i18n/messages.ts'
let s = fs.readFileSync(p, 'utf8')

const fixes = [
  ["'eph.uzSubLive': 'ITC / CCSDS OCM · gzip 存储 · 由 Starlink 公开镜像抽样',", /'eph\.uzSubLive':\s*'[^']*',/],
  ["'eph.subLive': '管理 · 预览 · 本地 ITC/OCM（Starlink 公开镜像）',", /'eph\.subLive':\s*'管理[^']*',/],
]
// Replace zh uzSubLive specifically — find first occurrence
let first = true
s = s.replace(/'eph\.uzSubLive':\s*'[^']*',/g, () => {
  if (first) {
    first = false
    return "'eph.uzSubLive': 'ITC / CCSDS OCM · gzip 存储 · 由 Starlink 公开镜像抽样',"
  }
  return "'eph.uzSubLive': 'ITC / CCSDS OCM · stored gzip · sampled from Starlink public mirror',"
})
first = true
s = s.replace(/'eph\.subLive':\s*'[^']*',/g, () => {
  if (first) {
    first = false
    return "'eph.subLive': '管理 · 预览 · 本地 ITC/OCM（Starlink 公开镜像）',"
  }
  return "'eph.subLive': 'Manage · preview · local ITC/OCM (Starlink public mirror)',"
})
// Fix en eph.sub middle-dot garble
s = s.replace(/"eph\.sub":\s*'Manage[^']*',/, `"eph.sub": 'Manage · preview · local Starlink ephemerides',`)

fs.writeFileSync(p, s, 'utf8')
console.log('rewrote uzSubLive/subLive')
// verify bytes of zh uzSubLive
const m = s.match(/'eph\.uzSubLive':\s*'([^']+)'/)
console.log('first uzSubLive:', m && m[1])
