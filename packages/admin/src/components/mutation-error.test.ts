// @vitest-environment happy-dom
import * as React from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { MutationError } from "./mutation-error.js"

afterEach(cleanup)

describe("MutationError", () => {
  it("displays the server's error message verbatim, not a generic fallback", () => {
    const serverMessage = 'Unknown settings column: "refusal_txt" (did you mean "refusal_text"?)'
    render(React.createElement(MutationError, { message: serverMessage }))

    expect(screen.queryByText(serverMessage)).not.toBeNull()
    expect(screen.queryByText(/something went wrong/i)).toBeNull()
  })
})
