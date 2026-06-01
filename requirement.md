# GitHub Rendered Markdown Review Extension

## Project Overview

Build a browser extension that enhances GitHub Pull Request reviews by allowing reviewers to comment directly from the rendered Markdown view while still creating standard GitHub review comments attached to the correct source lines.

The extension should work on GitHub Pull Request pages where Markdown files (`.md`) are displayed in rendered form.

The goal is to eliminate the friction of switching between:

* Rendered Markdown view (human-readable)
* Source diff view (required for line comments)

The extension should provide a seamless experience where a reviewer can interact with rendered content and create native GitHub review comments.

---

# Background

GitHub's review system is source-line based.

When reviewing code:

* Reviewers comment on specific lines.
* GitHub anchors comments to source locations.

When reviewing Markdown documentation:

* Reviewers often want to evaluate rendered content.
* Examples:

  * README.md
  * AGENTS.md
  * CLAUDE.md
  * architecture docs
  * onboarding guides
  * AI context documents
  * product documentation

GitHub renders Markdown into HTML but disables line-level commenting in the rendered view.

As repositories increasingly contain AI-generated documentation and LLM context files, reviewing rendered output becomes more important than reviewing raw Markdown syntax.

This extension should bridge that gap.

---

# User Story

As a reviewer:

1. I open a GitHub Pull Request.
2. I view a Markdown file in rendered form.
3. I hover over a heading, paragraph, list item, table row, or code block.
4. I see a "Comment" action.
5. I click it.
6. I enter a review comment.
7. The extension maps the rendered element back to the corresponding Markdown source line.
8. A normal GitHub review comment is created.

The resulting comment should appear exactly like a native GitHub review comment.

---

# MVP Scope

Implement only the following initially:

## Supported Elements

* headings
* paragraphs
* list items
* blockquotes
* fenced code blocks

Ignore:

* tables
* HTML embedded in Markdown
* Mermaid diagrams
* nested edge cases

---

# Technical Approach

## Step 1

Detect GitHub PR pages.

Examples:

/pull/<id>/files

and rendered markdown views within a PR.

---

## Step 2

Identify rendered Markdown containers.

GitHub typically renders Markdown into containers such as:

```html
<div class="markdown-body">
```

The extension should locate rendered content.

---

## Step 3

Obtain Original Markdown

Possible sources:

### Option A

Read Markdown source already present in DOM.

### Option B

Fetch file contents through GitHub APIs.

### Option C

Use GitHub page data if available.

Goal:

Retrieve raw Markdown text.

---

## Step 4

Build Source Mapping

Use:

* remark
* unified
* mdast

Parse Markdown into AST.

Capture:

* node type
* source position
* start line
* end line

Example:

```json
{
  "type": "heading",
  "startLine": 12,
  "endLine": 12
}
```

---

## Step 5

Build Render Mapping

Render the same Markdown locally.

Recommended:

* remark
* rehype

Generate HTML.

Attach metadata:

```html
<h2 data-start-line="12">
```

Create a mapping between:

Rendered element
↔
Source line

---

## Step 6

Match GitHub Rendered Elements

Compare local rendered structure with GitHub rendered structure.

Potential strategies:

### Strategy A

Sequential traversal

Map:

Local H1 -> GitHub H1

Local P -> GitHub P

Local LI -> GitHub LI

### Strategy B

Structural fingerprint

Generate identifiers:

```text
heading|Authentication
paragraph|This API requires...
```

Match elements based on content.

MVP can use Strategy A.

---

## Step 7

Inject Review Controls

On hover:

Show small comment icon.

Example:

```html
<button>
💬
</button>
```

Position beside:

* headings
* paragraphs
* list items

---

## Step 8

Create Review Comment

Investigate GitHub review mechanisms.

Possible approaches:

### Preferred

Reuse native GitHub review UI.

When user clicks comment:

* Navigate to source location
* Open GitHub's own comment widget
* Pre-fill context

### Alternative

Use GitHub APIs.

Requires:

* repository
* pull request
* commit SHA
* file path
* line number

Research:

Pull Request Review Comments API.

---

# Architecture

## Extension Type

Manifest V3

### Components

Background script

Content script

GitHub page adapter

Markdown mapping engine

Comment integration layer

UI overlay layer

---

# Non-Goals

Do not:

* support all Markdown edge cases
* modify GitHub backend
* create a separate review system
* store comments externally

Comments must remain native GitHub comments.

---

# Future Enhancements

## Phase 2

Support:

* tables
* task lists
* Mermaid
* images

## Phase 3

Inline AI review suggestions.

Examples:

* grammar issues
* broken links
* unclear wording
* duplicated sections

## Phase 4

Rendered selection comments.

Example:

Select text within a paragraph.

Click:

"Comment on selection"

The extension determines the nearest Markdown source range.

---

# Success Criteria

A reviewer can:

1. Open a GitHub PR.
2. View rendered Markdown.
3. Hover a paragraph.
4. Click Comment.
5. Submit feedback.
6. See a standard GitHub review comment attached to the correct source line.

No GitHub backend changes required.

No external comment storage.

Works entirely as a browser extension.
