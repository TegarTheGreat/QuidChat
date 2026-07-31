import * as React from "react"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent } from "../components/ui/card"
import { ConfirmDialog } from "../components/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog"
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { MutationError } from "../components/mutation-error"
import { RowActions } from "../components/row-actions"
import { Skeleton } from "../components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs"
import { Textarea } from "../components/ui/textarea"
import { useFetch } from "../hooks/use-fetch"
import { api, type Source, type SourceStatus } from "../lib/api"

function statusVariant(status: SourceStatus): "default" | "secondary" | "destructive" {
  if (status === "ready") return "default"
  if (status === "error") return "destructive"
  return "secondary"
}

/**
 * What the assistant is allowed to answer from.
 *
 * The three ways in used to be two permanently-open forms and a command line: pasted text and a
 * URL had forms stacked below the table, and a PDF could only be added by someone with shell
 * access — which for a price list, the single most asked-about document in a shop, is the wrong
 * person. They are one dialog now, and the table is the page.
 *
 * Re-reading a page is the action that was most missing. A page indexed once was frozen, so a
 * shop that changed its delivery terms kept answering from the old wording while citing the same
 * URL: confidently wrong with a citation attached, which is the failure this product exists to
 * prevent.
 */
export function KnowledgePage({ tenantSlug }: { tenantSlug: string }) {
  const [reloadKey, setReloadKey] = React.useState(0)
  const sources = useFetch(() => api.listSources(tenantSlug), [tenantSlug, reloadKey])

  const [adding, setAdding] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Source | null>(null)

  const reload = () => setReloadKey((k) => k + 1)

  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await fn()
      reload()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Knowledge</h1>
        <Button size="sm" onClick={() => setAdding(true)}>
          Add source
        </Button>
      </div>

      {error && <MutationError message={error} />}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      <Card>
        <CardContent className="p-0">
          {sources.status === "pending" && (
            <div className="space-y-2 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
          {sources.status === "error" && (
            <div className="p-4">
              <MutationError message={sources.message} />
            </div>
          )}
          {sources.status === "success" && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead className="hidden sm:table-cell">Where from</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.data.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground">
                      Nothing indexed yet. Until something is, every question is refused — which
                      is the assistant working, not failing.
                    </TableCell>
                  </TableRow>
                )}
                {sources.data.map((source) => (
                  <TableRow key={source.id}>
                    <TableCell className="font-medium">{source.title}</TableCell>
                    <TableCell className="hidden max-w-xs truncate text-xs text-muted-foreground sm:table-cell">
                      {source.kind === "url" ? source.uri : source.kind === "file" ? "uploaded file" : "pasted text"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(source.status)}>{source.status}</Badge>
                      {source.status === "error" && (
                        <p className="mt-1 max-w-xs text-xs text-destructive">
                          {source.error ?? "No reason was recorded."}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <RowActions
                        label={`Actions for ${source.title}`}
                        actions={[
                          // Only a page can be re-read: pasted text has no upstream, and a PDF
                          // would have to be uploaded again. Offering it anyway would be a menu
                          // item that always fails.
                          ...(source.kind === "url"
                            ? [
                                {
                                  label: "Re-read this page",
                                  disabled: busy,
                                  onSelect: () =>
                                    void act(async () => {
                                      setNotice(null)
                                      const result = await api.reindexSource({
                                        tenantSlug,
                                        id: source.id,
                                      })
                                      setNotice(
                                        result.status === "ready"
                                          ? `Re-read “${source.title}” — ${result.chunkCount} pieces indexed.`
                                          : `Could not re-read “${source.title}”: ${result.error ?? "unknown reason"}. The old text is still in use.`,
                                      )
                                    }),
                                },
                              ]
                            : []),
                          {
                            label: "Delete",
                            destructive: true,
                            disabled: busy,
                            onSelect: () => setPendingDelete(source),
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <AddSourceDialog
            busy={busy}
            onText={async (title, text) => {
              const ok = await act(() => api.createTextSource({ tenantSlug, title, text }))
              if (ok) setAdding(false)
            }}
            onUrl={async (url, title) => {
              const ok = await act(() =>
                api.createUrlSource({ tenantSlug, url, ...(title ? { title } : {}) }),
              )
              if (ok) setAdding(false)
            }}
            onCrawl={async (url, maxPages) => {
              const ok = await act(async () => {
                setNotice("Reading the site. This takes a moment — one page at a time.")
                const result = await api.crawlSite({ tenantSlug, url, maxPages })
                setNotice(
                  `Indexed ${result.indexed.length} page${result.indexed.length === 1 ? "" : "s"}` +
                    (result.failed.length > 0
                      ? `. ${result.failed.length} could not be read: ${result.failed
                          .slice(0, 3)
                          .map((f) => f.url)
                          .join(", ")}`
                      : "."),
                )
              })
              if (ok) setAdding(false)
            }}
            onPdf={async (title, data) => {
              const ok = await act(() => api.createPdfSource({ tenantSlug, title, data }))
              if (ok) setAdding(false)
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete “${pendingDelete?.title}”?`}
        description="Its text and everything indexed from it goes with it, and the assistant stops answering from it immediately. Past answers stay in the transcript but no longer link to it. The source has to be added again."
        confirmLabel="Delete it"
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          if (!target) return
          void act(async () => {
            await api.deleteSource({ tenantSlug, id: target.id })
            setPendingDelete(null)
          })
        }}
      />
    </div>
  )
}

/** Reads a file in the browser. The server takes base64 in JSON — one encoder is less to get
 *  wrong than a multipart parser, and the panel is the only client. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => reject(new Error("that file could not be read")))
    reader.addEventListener("load", () => {
      const result = String(reader.result)
      // A data: URL, of which only the part after the comma is the file itself.
      resolve(result.slice(result.indexOf(",") + 1))
    })
    reader.readAsDataURL(file)
  })
}

function AddSourceDialog({
  busy,
  onText,
  onUrl,
  onPdf,
  onCrawl,
}: {
  busy: boolean
  onText: (title: string, text: string) => void
  onUrl: (url: string, title: string) => void
  onPdf: (title: string, data: string) => void
  onCrawl: (url: string, maxPages: number) => void
}): React.ReactElement {
  const [title, setTitle] = React.useState("")
  const [text, setText] = React.useState("")
  const [url, setUrl] = React.useState("")
  const [siteUrl, setSiteUrl] = React.useState("")
  const [maxPages, setMaxPages] = React.useState("10")
  const [file, setFile] = React.useState<File | null>(null)
  const [reading, setReading] = React.useState(false)

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Add a source</DialogTitle>
        <DialogDescription>
          The assistant answers only from what is here, and cites it.
        </DialogDescription>
      </DialogHeader>

      <Tabs defaultValue="text">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="text">Paste text</TabsTrigger>
          <TabsTrigger value="url">A page</TabsTrigger>
          <TabsTrigger value="site">A whole site</TabsTrigger>
          <TabsTrigger value="pdf">A PDF</TabsTrigger>
        </TabsList>

        <TabsContent value="text" className="space-y-3 pt-3">
          <div className="space-y-1">
            <Label htmlFor="source-title">Title</Label>
            <Input
              id="source-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Kebijakan Garansi"
            />
            <p className="text-xs text-muted-foreground">
              Customers see this name under any answer that came from it.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-text">Text</Label>
            <Textarea
              id="source-text"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={busy || title.trim() === "" || text.trim() === ""}
              onClick={() => onText(title.trim(), text)}
            >
              Index this text
            </Button>
          </DialogFooter>
        </TabsContent>

        <TabsContent value="url" className="space-y-3 pt-3">
          <div className="space-y-1">
            <Label htmlFor="source-url">Address</Label>
            <Input
              id="source-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://tokosaya.example/pengiriman"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-url-title">Title (optional)</Label>
            <Input
              id="source-url-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="taken from the page when left empty"
            />
          </div>
          <DialogFooter>
            <Button disabled={busy || url.trim() === ""} onClick={() => onUrl(url.trim(), title.trim())}>
              Read the page
            </Button>
          </DialogFooter>
        </TabsContent>

        {/* The thing a business actually asks for — "point it at my website" — which until now
            needed shell access to the server. */}
        <TabsContent value="site" className="space-y-3 pt-3">
          <div className="space-y-1">
            <Label htmlFor="source-site">Address to start from</Label>
            <Input
              id="source-site"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://tokosaya.example"
            />
            <p className="text-xs text-muted-foreground">
              Links are followed from this page, nearest first, and robots.txt is respected. A
              sitemap address works too, and is read exactly as written.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-site-pages">How many pages at most</Label>
            <Input
              id="source-site-pages"
              type="number"
              min={1}
              max={25}
              value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Up to 25. Every page is fetched and indexed before this dialog closes, so a large
              site is better done in a few passes.
            </p>
          </div>
          <DialogFooter>
            <Button
              disabled={busy || siteUrl.trim() === ""}
              onClick={() => onCrawl(siteUrl.trim(), Number(maxPages) || 10)}
            >
              {busy ? "Reading the site…" : "Read this site"}
            </Button>
          </DialogFooter>
        </TabsContent>

        <TabsContent value="pdf" className="space-y-3 pt-3">
          <div className="space-y-1">
            <Label htmlFor="source-pdf-title">Title</Label>
            <Input
              id="source-pdf-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Daftar Harga 2026"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-pdf">File</Label>
            <Input
              id="source-pdf"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">
              Up to about 9 MB. A scanned PDF is refused with the reason — it draws its letters as
              pictures, so it has to go through OCR before anything can read it.
            </p>
          </div>
          <DialogFooter>
            <Button
              disabled={busy || reading || !file || title.trim() === ""}
              onClick={async () => {
                if (!file) return
                setReading(true)
                try {
                  onPdf(title.trim(), await readAsBase64(file))
                } finally {
                  setReading(false)
                }
              }}
            >
              {reading ? "Reading…" : "Upload and index"}
            </Button>
          </DialogFooter>
        </TabsContent>
      </Tabs>
    </DialogContent>
  )
}
