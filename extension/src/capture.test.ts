import { beforeEach, describe, expect, it } from "vitest";
import { buildSelector } from "./selector";
import { buildXPath } from "./xpath";

function mount(html: string): void {
  document.body.innerHTML = html;
}

describe("buildSelector", () => {
  beforeEach(() => mount(""));

  it("prefers data-testid", () => {
    mount('<div><button data-testid="save-btn">Save</button></div>');
    const el = document.querySelector("[data-testid]")!;
    expect(buildSelector(el)).toBe('[data-testid="save-btn"]');
  });

  it("uses id when present", () => {
    mount('<div><button id="submit-order">Go</button></div>');
    const el = document.getElementById("submit-order")!;
    expect(buildSelector(el)).toBe("#submit-order");
  });

  it("builds nth-of-type path for anonymous elements", () => {
    mount("<ul><li>one</li><li>two</li><li>three</li></ul>");
    const third = document.querySelectorAll("li")[2];
    const sel = buildSelector(third);
    expect(sel).toContain("nth-of-type(3)");
    expect(document.querySelector(sel)).toBe(third);
  });

  it("selector resolves back to the element", () => {
    mount(`
      <main id="app">
        <section class="settings">
          <form>
            <input type="email" name="email">
            <button class="btn btn-primary">Save</button>
          </form>
        </section>
      </main>
    `);
    const btn = document.querySelector(".btn-primary")!;
    const sel = buildSelector(btn);
    expect(document.querySelector(sel)).toBe(btn);
  });

  it("stops climbing at an id anchor", () => {
    mount('<div id="root"><nav><a href="/x">link</a></nav></div>');
    const a = document.querySelector("a")!;
    const sel = buildSelector(a);
    expect(sel.startsWith("#root")).toBe(true);
  });
});

describe("buildXPath", () => {
  beforeEach(() => mount(""));

  it("builds positional path", () => {
    mount("<ul><li>a</li><li>b</li></ul>");
    const second = document.querySelectorAll("li")[1];
    const xp = buildXPath(second);
    expect(xp).toBe("/html/body/ul/li[2]");
  });

  it("no index when single child of kind", () => {
    mount("<section><p>only</p></section>");
    const p = document.querySelector("p")!;
    expect(buildXPath(p)).toBe("/html/body/section/p");
  });
});
