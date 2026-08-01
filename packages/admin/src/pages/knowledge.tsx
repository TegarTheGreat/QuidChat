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
import { useT } from "../i18n"
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
  const t = useT()
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
        <h1 className="text-2xl font-semibold">{t.knowledge.title}</h1>
        <Button size="sm" onClick={() => setAdding(true)}>
          {t.knowledge.addSource}
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
                  <TableHead>{t.knowledge.columnTitle}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t.knowledge.columnWhere}</TableHead>
                  <TableHead>{t.knowledge.columnStatus}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.data.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground">
                      {t.knowledge.empty}
                    </TableCell>
                  </TableRow>
                )}
                {sources.data.map((source) => (
                  <TableRow key={source.id}>
                    <TableCell className="font-medium">{source.title}</TableCell>
                    <TableCell className="hidden max-w-xs truncate text-xs text-muted-foreground sm:table-cell">
                      {source.kind === "url"
                        ? source.uri
                        : source.kind === "file"
                          ? t.knowledge.fromFile
                          : t.knowledge.fromText}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(source.status)}>{source.status}</Badge>
                      {source.status === "error" && (
                        <p className="mt-1 max-w-xs text-xs text-destructive">
                          {source.error ?? t.knowledge.noReason}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <RowActions
                        label={t.common.actionsFor(source.title)}
                        actions={[
                          // Only a page can be re-read: pasted text has no upstream, and a PDF
                          // would have to be uploaded again. Offering it anyway would be a menu
                          // item that always fails.
                          ...(source.kind === "url"
                            ? [
                                {
                                  label: t.knowledge.reindex,
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
                                          ? t.knowledge.reindexed(source.title, result.chunkCount ?? 0)
                                          : t.knowledge.reindexFailed(
                                              source.title,
                                              result.error ?? t.knowledge.unknownReason,
                                            ),
                                      )
                                    }),
                                },
                              ]
                            : []),
                          {
                            label: t.common.delete,
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
                setNotice(t.knowledge.crawling)
                const result = await api.crawlSite({ tenantSlug, url, maxPages })
                setNotice(
                  result.failed.length > 0
                    ? t.knowledge.crawledWithFailures(
                        result.indexed.length,
                        result.failed.length,
                        result.failed.slice(0, 3).map((f) => f.url).join(", "),
                      )
                    : t.knowledge.crawled(result.indexed.length),
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
        title={t.knowledge.deleteTitle(pendingDelete?.title ?? "")}
        description={t.knowledge.deleteDescription}
        confirmLabel={t.knowledge.deleteConfirm}
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
  const t = useT()
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
        <DialogTitle>{t.knowledge.dialog.title}</DialogTitle>
        <DialogDescription>{t.knowledge.dialog.description}</DialogDescription>
      </DialogHeader>

      <Tabs defaultValue="text">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="text">{t.knowledge.dialog.tabText}</TabsTrigger>
          <TabsTrigger value="url">{t.knowledge.dialog.tabUrl}</TabsTrigger>
          <TabsTrigger value="site">{t.knowledge.dialog.tabSite}</TabsTrigger>
          <TabsTrigger value="pdf">{t.knowledge.dialog.tabPdf}</TabsTrigger>
        </TabsList>

        <TabsContent value="text" className="space-y-3 pt-3">
          <div className="space-y-1">
            <Label htmlFor="source-title">{t.knowledge.dialog.titleLabel}</Label>
            <Input
              id="source-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Kebijakan Garansi"
            />
            <p className="text-xs text-muted-foreground">{t.knowledge.dialog.titleHint}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-text">{t.knowledge.dialog.textLabel}</Label>
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
              {t.knowledge.dialog.indexText}
            </Button>
          </DialogFooter>
        </TabsContent>

        <TabsContent value="url" className="space-y-3 pt-3">
          <div className="space-y-1">
            <Label htmlFor="source-url">{t.knowledge.dialog.urlLabel}</Label>
            <Input
              id="source-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://tokosaya.example/pengiriman"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-url-title">{t.knowledge.dialog.urlTitleLabel}</Label>
            <Input
              id="source-url-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t.knowledge.dialog.urlTitlePlaceholder}
            />
          </div>
          <DialogFooter>
            <Button disabled={busy || url.trim() === ""} onClick={() => onUrl(url.trim(), title.trim())}>
              {t.knowledge.dialog.readPage}
            </Button>
          </DialogFooter>
        </TabsContent>

        {/* The thing a business actually asks for — "point it at my website" — which until now
            needed shell access to the server. */}
        <TabsContent value="site" className="space-y-3 pt-3">
          <div className="space-y-1">
            <Label htmlFor="source-site">{t.knowledge.dialog.siteLabel}</Label>
            <Input
              id="source-site"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://tokosaya.example"
            />
            <p className="text-xs text-muted-foreground">{t.knowledge.dialog.siteHint}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-site-pages">{t.knowledge.dialog.sitePagesLabel}</Label>
            <Input
              id="source-site-pages"
              type="number"
              min={1}
              max={25}
              value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t.knowledge.dialog.sitePagesHint}</p>
          </div>
          <DialogFooter>
            <Button
              disabled={busy || siteUrl.trim() === ""}
              onClick={() => onCrawl(siteUrl.trim(), Number(maxPages) || 10)}
            >
              {busy ? t.knowledge.dialog.readingSite : t.knowledge.dialog.readSite}
            </Button>
          </DialogFooter>
        </TabsContent>

        <TabsContent value="pdf" className="space-y-3 pt-3">
          <div className="space-y-1">
            <Label htmlFor="source-pdf-title">{t.knowledge.dialog.titleLabel}</Label>
            <Input
              id="source-pdf-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Daftar Harga 2026"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-pdf">{t.knowledge.dialog.pdfLabel}</Label>
            <Input
              id="source-pdf"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">{t.knowledge.dialog.pdfHint}</p>
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
              {reading ? t.knowledge.dialog.readingPdf : t.knowledge.dialog.uploadPdf}
            </Button>
          </DialogFooter>
        </TabsContent>
      </Tabs>
    </DialogContent>
  )
}
