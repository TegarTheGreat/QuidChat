import * as React from "react"
import { Button } from "./ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import { useToken } from "../hooks/use-token"
import { useT } from "../i18n"
import { setToken } from "../lib/token"

/**
 * Gate shown until an admin token is provided. The token is kept in memory
 * and `sessionStorage` only (see `lib/token.ts`) — never `localStorage`.
 */
export function TokenGate({ children }: { children: React.ReactNode }) {
  const t = useT()
  const token = useToken()
  const [draft, setDraft] = React.useState("")

  if (token) return <>{children}</>

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t.token.brand}</CardTitle>
          <CardDescription>{t.token.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (draft.trim().length > 0) setToken(draft.trim())
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="admin-token">{t.token.title}</Label>
              <Input
                id="admin-token"
                type="password"
                autoComplete="off"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="QUIDCHAT_ADMIN_TOKEN"
              />
            </div>
            <Button type="submit" className="w-full" disabled={draft.trim().length === 0}>
              {t.token.submit}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
