// SMTP email via nodemailer. Single shared transport; graceful no-op when
// SMTP_* env vars aren't set (local dev without a mail server).
import { createTransport, type Transporter } from 'nodemailer'

let cached: Transporter | null = null

function buildTransport(): Transporter | null {
  const host = process.env.SMTP_HOST
  const port = process.env.SMTP_PORT
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  if (!host || !port || !user || !pass) return null
  return createTransport({
    host,
    port: Number.parseInt(port, 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  })
}

function transporter(): Transporter | null {
  if (cached) return cached
  cached = buildTransport()
  return cached
}

export function isEmailConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS,
  )
}

export interface SendMailInput {
  to: string
  subject: string
  text: string
  html?: string
}

export async function sendMail(input: SendMailInput): Promise<void> {
  const t = transporter()
  const from = process.env.SMTP_FROM || process.env.SMTP_USER
  if (!t || !from) {
    console.warn('[email] SMTP not configured; skipping send to', input.to)
    return
  }
  try {
    await t.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html ?? input.text,
    })
  } catch (err) {
    console.error('[email] send failed:', err)
    throw err
  }
}
