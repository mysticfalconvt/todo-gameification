// HTML + text rendering for the weekly summary email. Pure function of the
// WeeklySummary (+ optional LLM analysis) so it's easy to test and reuse.
// Inline styles only — email clients strip <style> and external CSS.
import type { WeeklySummary } from '../services/weeklySummary'
import { findGame } from '../../games/registry'

function appUrl(): string {
  return (process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').replace(
    /\/$/,
    '',
  )
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function deltaText(delta: number, unit: string): string {
  if (delta === 0) return 'same as last week'
  const sign = delta > 0 ? '+' : '−'
  return `${sign}${Math.abs(delta)}${unit ? ` ${unit}` : ''} vs last week`
}

export interface RenderedEmail {
  subject: string
  text: string
  html: string
}

export function renderWeeklyEmail(
  summary: WeeklySummary,
  analysis: string | null,
  householdAnalysis: string | null = null,
): RenderedEmail {
  const k = summary.kpis
  const base = appUrl()
  const subject = `Your week: ${summary.weekStartLabel}–${summary.weekEndLabel} · ${k.completionsThisWeek} done, ${k.xpThisWeek} XP`

  // ---- Plain text ----
  const textLines: string[] = []
  textLines.push(`Week of ${summary.weekStartLabel}–${summary.weekEndLabel}`)
  textLines.push('')
  if (analysis) {
    textLines.push(analysis)
    textLines.push('')
  }
  textLines.push(
    `Completions: ${k.completionsThisWeek} (${deltaText(k.completionsThisWeek - k.completionsLastWeek, '')})`,
  )
  textLines.push(
    `XP earned: ${k.xpThisWeek} (${deltaText(k.xpThisWeek - k.xpLastWeek, 'XP')})`,
  )
  textLines.push(`Current streak: ${k.currentStreak} days (longest ${k.longestStreak})`)
  textLines.push(`Level ${k.level} · ${k.totalXp} total XP · ${k.tokens} tokens`)
  if (summary.topTasks.length > 0) {
    textLines.push('')
    textLines.push('Most-completed this week:')
    for (const t of summary.topTasks.slice(0, 5)) {
      textLines.push(`  - ${t.title} (${t.count}×)`)
    }
  }
  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  if (summary.xpByDay.some((d) => d.xp > 0 || d.count > 0)) {
    textLines.push('')
    textLines.push('By weekday:')
    summary.xpByDay.forEach((d, i) => {
      textLines.push(
        `  ${weekdayLabels[i] ?? `Day ${i + 1}`}: ${d.count} chores · ${d.xp} XP`,
      )
    })
  }
  const me = summary.leaderboard.find((r) => r.isMe)
  if (me && summary.leaderboard.length > 1) {
    textLines.push('')
    textLines.push(
      `Friends leaderboard: rank ${me.rank} of ${summary.leaderboard.length} (${me.value} XP this week)`,
    )
  }
  if (summary.household) {
    const h = summary.household
    textLines.push('')
    textLines.push(`${h.name} — your family's week:`)
    if (householdAnalysis) {
      textLines.push(householdAnalysis)
    }
    textLines.push(
      `  Family total: ${h.totalThisWeekCount} chores · ${h.totalThisWeekXp} XP this week (last week ${h.totalLastWeekCount} chores · ${h.totalLastWeekXp} XP)`,
    )
    for (const m of h.members) {
      textLines.push(
        `  - ${m.isMe ? `${m.name} (you)` : m.name}${m.role === 'kid' ? ' [kid]' : ''}: ${m.thisWeekCount} chores / ${m.thisWeekXp} XP this week (was ${m.lastWeekCount} / ${m.lastWeekXp})`,
      )
    }
  }
  textLines.push('')
  textLines.push(`See the full summary: ${base}/weekly-summary`)
  textLines.push(`Turn this email off: ${base}/settings`)
  const text = textLines.join('\n')

  // ---- HTML ----
  const ink = '#0f2a2f'
  const soft = '#2a4448'
  const lagoon = '#1f6e75'
  const line = 'rgba(23,58,64,0.18)'

  const kpiCell = (label: string, value: string, sub: string) => `
    <td style="padding:10px 12px;border:1px solid ${line};border-radius:12px;background:#ffffff;vertical-align:top;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${soft};">${esc(label)}</div>
      <div style="font-size:22px;font-weight:700;color:${ink};margin-top:2px;">${esc(value)}</div>
      <div style="font-size:11px;color:${soft};margin-top:2px;">${esc(sub)}</div>
    </td>`

  const topTasksHtml =
    summary.topTasks.length > 0
      ? `<h3 style="font-size:14px;color:${ink};margin:24px 0 8px;">Most-completed this week</h3>
         <ul style="margin:0;padding-left:18px;color:${ink};font-size:14px;">
           ${summary.topTasks
             .slice(0, 5)
             .map((t) => `<li style="margin:3px 0;">${esc(t.title)} <span style="color:${soft};">(${t.count}×)</span></li>`)
             .join('')}
         </ul>`
      : ''

  const repeating = summary.repeatingTasks.filter((r) => r.thisWeekCount > 0).slice(0, 5)
  const repeatingHtml =
    repeating.length > 0
      ? `<h3 style="font-size:14px;color:${ink};margin:24px 0 8px;">Habits you kept up</h3>
         <ul style="margin:0;padding-left:18px;color:${ink};font-size:14px;">
           ${repeating
             .map((r) => `<li style="margin:3px 0;">${esc(r.title)} <span style="color:${soft};">— ${r.thisWeekCount}× this week, ${r.allTimeCount} all-time</span></li>`)
             .join('')}
         </ul>`
      : ''

  const playedGames = summary.arcade.personal.filter((g) => g.played > 0).slice(0, 6)
  const arcadeHtml =
    playedGames.length > 0
      ? `<h3 style="font-size:14px;color:${ink};margin:24px 0 8px;">Arcade</h3>
         <ul style="margin:0;padding-left:18px;color:${ink};font-size:14px;">
           ${playedGames
             .map((g) => `<li style="margin:3px 0;">${esc(findGame(g.gameId)?.name ?? g.gameId)} <span style="color:${soft};">— ${g.won}/${g.played} won</span></li>`)
             .join('')}
         </ul>`
      : ''

  const lbHtml =
    me && summary.leaderboard.length > 1
      ? `<h3 style="font-size:14px;color:${ink};margin:24px 0 8px;">Friends leaderboard (XP, last 7 days)</h3>
         <ol style="margin:0;padding-left:18px;color:${ink};font-size:14px;">
           ${summary.leaderboard
             .slice(0, 8)
             .map((r) => `<li style="margin:3px 0;${r.isMe ? `font-weight:700;color:${lagoon};` : ''}">${esc(r.isMe ? 'You' : r.name || '@' + r.handle)} <span style="color:${soft};font-weight:400;">— ${r.value} XP</span></li>`)
             .join('')}
         </ol>`
      : ''

  // Household recap: the LLM family blurb + a per-member this-vs-last-week
  // table. Up/down arrows colored by direction. Absent for solo users.
  const householdHtml = (() => {
    const h = summary.household
    if (!h) return ''
    const dirSpan = (now: number, prev: number) => {
      const d = now - prev
      if (d === 0) return `<span style="color:${soft};">·</span>`
      const up = d > 0
      return `<span style="color:${up ? lagoon : soft};">${up ? '▲' : '▼'}${Math.abs(d)}</span>`
    }
    const blurb = householdAnalysis
      ? `<div style="background:#ffffff;border:1px solid ${line};border-radius:12px;padding:14px;margin:8px 0 12px;font-size:14px;line-height:1.6;color:${ink};white-space:pre-line;">${esc(householdAnalysis)}</div>`
      : ''
    const rows = h.members
      .map(
        (m) => `<tr>
          <td style="padding:4px 8px 4px 0;color:${ink};">${esc(m.isMe ? `${m.name} (you)` : m.name)}${m.role === 'kid' ? ` <span style="color:${soft};font-size:11px;">kid</span>` : ''}</td>
          <td style="padding:4px 0;text-align:right;white-space:nowrap;color:${soft};">${m.thisWeekCount} ${dirSpan(m.thisWeekCount, m.lastWeekCount)}</td>
          <td style="padding:4px 0 4px 12px;text-align:right;white-space:nowrap;color:${soft};">${m.thisWeekXp} XP ${dirSpan(m.thisWeekXp, m.lastWeekXp)}</td>
        </tr>`,
      )
      .join('')
    return `<h3 style="font-size:14px;color:${ink};margin:24px 0 8px;">${esc(h.name)} — your family's week</h3>
      ${blurb}
      <p style="font-size:12px;color:${soft};margin:0 0 6px;">Family total: ${h.totalThisWeekCount} chores · ${h.totalThisWeekXp} XP this week (last week ${h.totalLastWeekCount} · ${h.totalLastWeekXp} XP).</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="color:${soft};font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">
          <td style="padding:0 8px 4px 0;">Member</td>
          <td style="padding:0 0 4px;text-align:right;">Chores</td>
          <td style="padding:0 0 4px 12px;text-align:right;">XP</td>
        </tr>
        ${rows}
      </table>
      <p style="font-size:11px;color:${soft};margin:6px 0 0;">▲/▼ vs last week.</p>`
  })()

  // Per-weekday bars: XP (lagoon) and chores (green), each scaled to its
  // own max so both stay legible. Email-safe — table layout + div bars
  // sized with inline width percentages; no SVG.
  const palm = '#3f9d6b'
  const maxXpDay = summary.xpByDay.reduce((a, d) => Math.max(a, d.xp), 0) || 1
  const maxCountDay =
    summary.xpByDay.reduce((a, d) => Math.max(a, d.count), 0) || 1
  const byDayHtml = summary.xpByDay.some((d) => d.xp > 0 || d.count > 0)
    ? `<h3 style="font-size:14px;color:${ink};margin:24px 0 8px;">By weekday</h3>
       <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:12px;color:${soft};">
         ${summary.xpByDay
           .map((d, i) => {
             const xpW = Math.round((d.xp / maxXpDay) * 100)
             const countW = Math.round((d.count / maxCountDay) * 100)
             return `<tr>
               <td style="padding:3px 8px 3px 0;width:34px;color:${ink};font-weight:600;">${esc(weekdayLabels[i] ?? '')}</td>
               <td style="padding:3px 0;">
                 <div style="background:${line};border-radius:6px;height:8px;margin-bottom:3px;"><div style="background:${lagoon};width:${xpW}%;height:8px;border-radius:6px;"></div></div>
                 <div style="background:${line};border-radius:6px;height:8px;"><div style="background:${palm};width:${countW}%;height:8px;border-radius:6px;"></div></div>
               </td>
               <td style="padding:3px 0 3px 10px;white-space:nowrap;text-align:right;">${d.count} chores · ${d.xp} XP</td>
             </tr>`
           })
           .join('')}
       </table>
       <p style="font-size:11px;color:${soft};margin:6px 0 0;">
         <span style="display:inline-block;width:8px;height:8px;background:${lagoon};border-radius:2px;"></span> XP
         &nbsp;&nbsp;
         <span style="display:inline-block;width:8px;height:8px;background:${palm};border-radius:2px;"></span> Chores
       </p>`
    : ''

  const analysisHtml = analysis
    ? `<div style="background:#ffffff;border:1px solid ${line};border-radius:12px;padding:16px;margin:16px 0;">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:${soft};margin-bottom:6px;">Your week in review</div>
         <div style="font-size:15px;line-height:1.6;color:${ink};white-space:pre-line;">${esc(analysis)}</div>
       </div>`
    : ''

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f7f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:${soft};margin:0 0 4px;">Weekly summary</p>
    <h1 style="font-size:24px;color:${ink};margin:0 0 4px;">Week of ${esc(summary.weekStartLabel)}–${esc(summary.weekEndLabel)}</h1>
    <p style="font-size:13px;color:${soft};margin:0 0 16px;">Here's how the week went.</p>

    ${analysisHtml}

    <table role="presentation" cellpadding="0" cellspacing="6" style="width:100%;border-collapse:separate;">
      <tr>
        ${kpiCell('Completions', String(k.completionsThisWeek), deltaText(k.completionsThisWeek - k.completionsLastWeek, ''))}
        ${kpiCell('XP earned', String(k.xpThisWeek), deltaText(k.xpThisWeek - k.xpLastWeek, 'XP'))}
      </tr>
      <tr>
        ${kpiCell('Current streak', `${k.currentStreak}d`, `longest ${k.longestStreak}d`)}
        ${kpiCell('Tokens', String(k.tokens), `level ${k.level} · ${k.totalXp} XP`)}
      </tr>
    </table>

    ${byDayHtml}
    ${topTasksHtml}
    ${repeatingHtml}
    ${arcadeHtml}
    ${lbHtml}
    ${householdHtml}

    <div style="margin:28px 0 8px;">
      <a href="${base}/weekly-summary" style="display:inline-block;background:${lagoon};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:999px;">See your full summary →</a>
    </div>
    <p style="font-size:12px;color:${soft};margin:16px 0 0;">
      You're getting this because you turned on weekly summaries.
      <a href="${base}/settings" style="color:${lagoon};">Turn it off</a>.
    </p>
  </div>
</body>
</html>`

  return { subject, text, html }
}
