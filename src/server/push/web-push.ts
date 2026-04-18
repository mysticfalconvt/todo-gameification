import webpush from 'web-push'

let configured = false

function configure() {
  if (configured) return
  const subject = process.env.VAPID_SUBJECT
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!subject || !publicKey || !privateKey) {
    throw new Error(
      'VAPID_SUBJECT, VAPID_PUBLIC_KEY, and VAPID_PRIVATE_KEY must all be set',
    )
  }
  webpush.setVapidDetails(subject, publicKey, privateKey)
  configured = true
}

export interface PushPayload {
  title: string
  body: string
  tag?: string
  taskInstanceId?: string
  url?: string
}

export interface PushTarget {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export type SendResult =
  | { ok: true }
  | { ok: false; statusCode: number | undefined; gone: boolean }

export async function sendWebPush(
  target: PushTarget,
  payload: PushPayload,
): Promise<SendResult> {
  configure()
  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: target.keys },
      JSON.stringify(payload),
    )
    return { ok: true }
  } catch (err) {
    const statusCode = (err as { statusCode?: number } | undefined)?.statusCode
    const gone = statusCode === 404 || statusCode === 410
    return { ok: false, statusCode, gone }
  }
}
