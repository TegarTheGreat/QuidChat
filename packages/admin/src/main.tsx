import * as React from "react"
import * as ReactDOM from "react-dom/client"
import { App } from "./App"
import { LocaleProvider } from "./i18n"
import "./index.css"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
)
