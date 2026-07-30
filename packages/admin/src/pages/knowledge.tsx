import * as React from "react"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { MutationError } from "../components/mutation-error"
import { Skeleton } from "../components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table"
import { Textarea } from "../components/ui/textarea"
import { useFetch } from "../hooks/use-fetch"
import { useMutation } from "../hooks/use-mutation"
import { api, type SourceStatus } from "../lib/api"

function statusVariant(status: SourceStatus): "default" | "secondary" | "destructive" {
  if (status === "ready") return "default"
  if (status === "error") return "destructive"
  return "secondary"
}

export function KnowledgePage({ tenantSlug }: { tenantSlug: string }) {
  const [reloadKey, setReloadKey] = React.useState(0)
  const sources = useFetch(() => api.listSources(tenantSlug), [tenantSlug, reloadKey])

  const [title, setTitle] = React.useState("")
  const [text, setText] = React.useState("")
  const { state: createState, mutate: createSource } = useMutation(api.createTextSource)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    await createSource({ tenantSlug, title, text })
    setTitle("")
    setText("")
    setReloadKey((k) => k + 1)
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Knowledge</h1>
      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
        </CardHeader>
        <CardContent>
          {sources.status === "pending" && (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
          {sources.status === "error" && <MutationError message={sources.message} />}
          {sources.status === "success" && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.data.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-muted-foreground">
                      No sources yet. Add one below.
                    </TableCell>
                  </TableRow>
                )}
                {sources.data.map((source) => (
                  <TableRow key={source.id}>
                    <TableCell>{source.title}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(source.status)}>{source.status}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-destructive">
                      {source.status === "error" ? (source.error ?? "No error message provided.") : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add a text source</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="source-title">Title</Label>
              <Input
                id="source-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="source-text">Text</Label>
              <Textarea
                id="source-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                required
              />
            </div>
            {createState.status === "error" && <MutationError message={createState.message} />}
            <Button type="submit" disabled={createState.status === "pending"}>
              {createState.status === "pending" ? "Adding…" : "Add source"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
