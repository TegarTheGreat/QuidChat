// @vitest-environment happy-dom
import * as React from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { OriginsField } from "./origins-field.js"

afterEach(cleanup)

describe("OriginsField", () => {
  it("flags an empty allowed_origins list as disabling the widget", () => {
    render(React.createElement(OriginsField, { value: [], onChange: () => {} }))

    expect(screen.queryByText("Widget disabled")).not.toBeNull()
  })

  it("does not show the warning once at least one origin is configured", () => {
    render(
      React.createElement(OriginsField, {
        value: ["https://example.com"],
        onChange: () => {},
      }),
    )

    expect(screen.queryByText("Widget disabled")).toBeNull()
  })
})
