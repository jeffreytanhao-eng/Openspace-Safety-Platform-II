import fs from 'node:fs'
const p = 'D:/项目/Openspace Safety/web/src/i18n/messages.ts'
let s = fs.readFileSync(p, 'utf8')

// Fix corrupted eph.sub lines
s = s.replace(
  /"eph\.sub":\s*'[^']*',`r`n\s*'eph\.subLive':\s*'[^']*',,?/,
  `"eph.sub": '管理 · 预览 · 本地 Starlink 星历',`
)
s = s.replace(
  /"eph\.sub":\s*'Manage[^']*',,?/,
  `"eph.sub": 'Manage · preview · local Starlink ephemerides',`
)

const zhBlock = `
    'eph.subLive': '管理 · 预览 · 本地 ITC/OCM（Starlink 公开镜像）',
    'eph.toSituation': '关联至态势',
    'eph.toSituationHint': '跳转态势窗口：目标 + 浅蓝轨道；若有机动则以琥珀橙色区分绘制',
    'eph.maneuver': '机动信息',
    'eph.originator': '来源',
    'eph.file': '文件',
    'eph.uzTitleLive': '本地星历目录（data/ephemerides）',
    'eph.uzSubLive': 'ITC / CCSDS OCM · gzip 存储 · 由 Starlink 公开镜像抽样',
    'eph.uploadHint': '当前列表来自本地目录；上传入库仍走态势「星历分析」面板',
    'eph.liveNote': '列表来自 data/ephemerides（ITC + 派生 OCM）。状态 LOCAL = 已落盘。',`

const enBlock = `
    'eph.subLive': 'Manage · preview · local ITC/OCM (Starlink public mirror)',
    'eph.toSituation': 'Open in Situation',
    'eph.toSituationHint': 'Jump to Situation: target + light-blue orbit; maneuvers in amber if present',
    'eph.maneuver': 'Maneuvers',
    'eph.originator': 'Originator',
    'eph.file': 'File',
    'eph.uzTitleLive': 'Local ephemeris folder (data/ephemerides)',
    'eph.uzSubLive': 'ITC / CCSDS OCM · stored gzip · sampled from Starlink public mirror',
    'eph.uploadHint': 'List is from the local folder; upload still goes through Situation Ephem panel',
    'eph.liveNote': 'List from data/ephemerides (ITC + derived OCM). LOCAL = on disk.',`

// Strip any existing new keys
for (const k of [
  'eph.subLive','eph.toSituation','eph.toSituationHint','eph.maneuver','eph.originator',
  'eph.file','eph.uzTitleLive','eph.uzSubLive','eph.uploadHint','eph.liveNote'
]) {
  s = s.replace(new RegExp(`^[ \\t]*['\"]${k.replace(/\./g,'\\.')}['\"]:\\s*'[^']*',\\r?\\n`, 'gm'), '')
}

let n = 0
s = s.replace(/("eph\.none":\s*'[^']*',)/g, (m) => {
  n++
  return m + (n === 1 ? zhBlock : enBlock)
})

fs.writeFileSync(p, s)
console.log('fixed, eph.none hits=', n)
