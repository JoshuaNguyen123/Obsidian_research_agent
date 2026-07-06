from __future__ import annotations

import html2text
from bs4 import BeautifulSoup


def html_to_markdown(html: str, base_url: str, include_links: bool = True) -> str:
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup(["script", "style", "noscript", "svg"]):
        tag.decompose()

    converter = html2text.HTML2Text()
    converter.ignore_links = not include_links
    converter.body_width = 0
    converter.protect_links = True
    converter.baseurl = base_url

    markdown = converter.handle(str(soup))
    return "\n".join(line.rstrip() for line in markdown.splitlines()).strip()
