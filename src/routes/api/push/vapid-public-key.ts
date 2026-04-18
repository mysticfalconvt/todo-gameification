import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/push/vapid-public-key')({
  server: {
    handlers: {
      GET: async () => {
        const publicKey = process.env.VAPID_PUBLIC_KEY
        if (!publicKey) {
          return new Response('VAPID not configured', { status: 500 })
        }
        return Response.json({ publicKey })
      },
    },
  },
})
