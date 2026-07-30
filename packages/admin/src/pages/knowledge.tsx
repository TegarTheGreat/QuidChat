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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog"
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

  const [url, setUrl] = React.useState("")
  const [urlTitle, setUrlTitle] = React.useState("")
  const { state: urlState, mutate: createFromUrl } = useMutation(api.createUrlSource)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    await createSource({ tenantSlug, title, text })
    setTitle("")
    setText("")
    setReloadKey((k) => k + 1)
  }

  // Held as the pending row rather than a boolean, so the dialog can name what is about to be
  // deleted. A confirmation that does not say which source it means is one people click
  // through without reading.
  const [pendingDelete, setPendingDelete] = React.useState<{ id: string; title: string } | null>(null)
  const { state: deleteState, mutate: removeSource } = useMutation(api.deleteSource)

  async function confirmDelete() {
    if (!pendingDelete) return
    await removeSource({ tenantSlug, id: pendingDelete.id })
    setPendingDelete(null)
    setReloadKey((k) => k + 1)
  }

  async function handleUrlSubmit(event: React.FormEvent) {
    event.preventDefault()
    await createFromUrl({
      tenantSlug,
      url,
      ...(urlTitle.trim() ? { title: urlTitle.trim() } : {}),
    })
    setUrl("")
    setUrlTitle("")
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
                  <TableHead className="text-right">Remove</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.data.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground">
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
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setPendingDelete({ id: source.id, title: source.title })}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{pendingDelete?.title}&rdquo;?</DialogTitle>
            <DialogDescription>
              Its text and everything indexed from it goes with it, and the assistant will stop
              answering from it immediately. Past answers stay in the transcript but will no
              longer link to it. This cannot be undone — the source has to be added again.
            </DialogDescription>
          </DialogHeader>
          {deleteState.status === "error" && <MutationError message={deleteState.message} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingDelete(null)}>
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteState.status === "pending"}
              onClick={confirmDelete}
            >
              {deleteState.status === "pending" ? "Deleting…" : "Delete it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>Read a page from your site</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleUrlSubmit}>
            <div className="space-y-2">
              <Label htmlFor="source-url">Page address</Label>
              <Input
                id="source-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://myshop.example/delivery"
                required
              />
              <p className="text-xs text-muted-foreground">
                One page at a time, and only the readable text — menus, footers and scripts
                are dropped, because a menu repeated across a site becomes near-identical
                chunks that crowd out the real answer. If the page builds its content in the
                browser there is nothing to read, and pasting the text below works instead.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="source-url-title">Name it (optional)</Label>
              <Input
                id="source-url-title"
                value={urlTitle}
                onChange={(e) => setUrlTitle(e.target.value)}
                placeholder="Delivery terms"
              />
              <p className="text-xs text-muted-foreground">
                This is the name your customer sees attached to the answer. The page&rsquo;s own
                title is used if you leave it blank, and &ldquo;Home | Acme&rdquo; is harder to
                recognise than &ldquo;Delivery terms&rdquo;.
              </p>
            </div>
            {urlState.status === "error" && <MutationError message={urlState.message} />}
            <Button type="submit" disabled={urlState.status === "pending"}>
              {urlState.status === "pending" ? "Reading…" : "Read and index"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Paste text instead</CardTitle>
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
