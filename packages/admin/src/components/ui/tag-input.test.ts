// @vitest-environment happy-dom
import * as React from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { TagInput } from "./tag-input.js"

afterEach(cleanup)

/** A thin controlled wrapper, since `TagInput` takes value/onChange like the
 *  rest of the form fields it is used alongside. */
function Wrapper() {
  const [value, setValue] = React.useState<string[]>(["https://existing.example"])
  return React.createElement(TagInput, {
    value,
    onChange: setValue,
    "aria-label": "Allowed origins",
  })
}

describe("TagInput", () => {
  it("adds a new value on Enter and removes a value via its remove button", () => {
    render(React.createElement(Wrapper))

    const input = screen.getByRole("textbox", { name: "Allowed origins" })
    fireEvent.change(input, { target: { value: "https://new.example" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(screen.queryByText("https://new.example")).not.toBeNull()
    expect(screen.queryByText("https://existing.example")).not.toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Remove https://existing.example" }))

    expect(screen.queryByText("https://existing.example")).toBeNull()
    expect(screen.queryByText("https://new.example")).not.toBeNull()
  })
})
