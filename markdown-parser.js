if (typeof window.MarkdownParser !== 'undefined') { /* already loaded */ } else
window.MarkdownParser = (() => {
  function parse(markdown) {
    const lines = markdown.split('\n');
    const blocks = [];
    let i = 0;
    let inTable = false;

    while (i < lines.length) {
      const line = lines[i];

      if (line.trim() === '') {
        i++;
        continue;
      }

      // Skip table rows (pipes)
      if (line.trim().startsWith('|') || line.trim().match(/^\|?[\s-:|]+\|/)) {
        i++;
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        blocks.push({
          type: 'heading',
          level: headingMatch[1].length,
          text: headingMatch[2].trim(),
          startLine: i + 1,
          endLine: i + 1
        });
        i++;
        continue;
      }

      if (line.match(/^```/)) {
        const startLine = i + 1;
        i++;
        while (i < lines.length && !lines[i].match(/^```\s*$/)) {
          i++;
        }
        blocks.push({
          type: 'code',
          startLine: startLine,
          endLine: i + 1
        });
        i++;
        continue;
      }

      if (line.match(/^>\s*/)) {
        const startLine = i + 1;
        const textParts = [];
        while (i < lines.length && lines[i].match(/^>\s*/)) {
          textParts.push(lines[i].replace(/^>\s*/, ''));
          i++;
        }
        blocks.push({
          type: 'blockquote',
          text: textParts.join(' ').trim(),
          startLine: startLine,
          endLine: i
        });
        continue;
      }

      if (line.match(/^\s*[-*+]\s+/) || line.match(/^\s*\d+\.\s+/)) {
        const startLine = i + 1;
        const text = line.replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+\.\s+/, '').trim();

        // Consume continuation lines (indented under this list item)
        let endLine = i + 1;
        i++;
        while (i < lines.length) {
          const nextLine = lines[i];
          // Sub-list item or continuation
          if (nextLine.match(/^\s{2,}[-*+]\s+/) || nextLine.match(/^\s{2,}\d+\.\s+/)) {
            // Sub-list item - don't consume, let the next iteration handle it
            break;
          }
          if (nextLine.match(/^\s{2,}\S/) && !nextLine.match(/^[-*+]\s/) && !nextLine.match(/^\d+\.\s/)) {
            endLine = i + 1;
            i++;
          } else {
            break;
          }
        }

        blocks.push({
          type: 'listitem',
          text: text,
          startLine: startLine,
          endLine: endLine
        });
        continue;
      }

      // Horizontal rules
      if (line.match(/^---\s*$/) || line.match(/^\*\*\*\s*$/) || line.match(/^___\s*$/)) {
        i++;
        continue;
      }

      // Paragraph (default)
      const startLine = i + 1;
      const textParts = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() !== '' &&
             !lines[i].match(/^#{1,6}\s/) &&
             !lines[i].match(/^>/) &&
             !lines[i].match(/^```/) &&
             !lines[i].match(/^\s*[-*+]\s+/) &&
             !lines[i].match(/^\s*\d+\.\s+/) &&
             !lines[i].match(/^---\s*$/) &&
             !lines[i].match(/^\|/)) {
        textParts.push(lines[i].trim());
        i++;
      }
      blocks.push({
        type: 'paragraph',
        text: textParts.join(' '),
        startLine: startLine,
        endLine: i
      });
    }

    return blocks;
  }

  function isHeadingElement(el) {
    const tag = el.tagName.toLowerCase();
    if (tag.match(/^h[1-6]$/)) return true;
    if (el.classList.contains('heading-element')) return true;
    return false;
  }

  function isListItem(el) {
    return el.tagName.toLowerCase() === 'li';
  }

  function isParagraph(el) {
    return el.tagName.toLowerCase() === 'p';
  }

  function isBlockquote(el) {
    return el.tagName.toLowerCase() === 'blockquote';
  }

  function isCodeBlock(el) {
    const tag = el.tagName.toLowerCase();
    return tag === 'pre' || (tag === 'div' && el.classList.contains('highlight'));
  }

  function getElementType(el) {
    if (isHeadingElement(el)) return 'heading';
    if (isListItem(el)) return 'listitem';
    if (isParagraph(el)) return 'paragraph';
    if (isBlockquote(el)) return 'blockquote';
    if (isCodeBlock(el)) return 'code';
    return null;
  }

  function matchDomElements(blocks, domElements) {
    const mappings = [];
    let blockIdx = 0;

    for (const el of domElements) {
      if (blockIdx >= blocks.length) break;

      const elType = getElementType(el);
      if (!elType) continue;

      const block = blocks[blockIdx];
      let matched = false;

      if (elType === block.type) {
        matched = true;
      }

      if (!matched) {
        // Look ahead up to 8 blocks for a match
        const searchAhead = Math.min(blockIdx + 8, blocks.length);
        for (let j = blockIdx + 1; j < searchAhead; j++) {
          if (elType === blocks[j].type) {
            blockIdx = j;
            matched = true;
            break;
          }
        }
      }

      if (matched) {
        mappings.push({
          element: el,
          block: blocks[blockIdx],
          startLine: blocks[blockIdx].startLine,
          endLine: blocks[blockIdx].endLine
        });
        blockIdx++;
      }
    }

    return mappings;
  }

  return { parse, matchDomElements, getElementType };
})();
