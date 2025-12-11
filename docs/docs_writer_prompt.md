Steps:
1) Open the docs file you asked to edit.
2) Use playwright MCP to navigate to the specific part of the software described in this file.
3) Use playwright MCP to walk around and see other places, proimitives this functianality is related to.
4) Document.

Screenshots:
Each docs page should have at least one related screenshot at the top. It's ok to add more screenshots along the way if needed. The more screenshots the better.
Screenshots should be stored in /docs/assets/automated_screenshots/{page name}_{what's on the screenshot}.png. Make screenshots "realistic" by pre-filling forms. When creating a screenshot, make sure that scroll position makes sense and no important elements are hidden.

Playwright:
Make sure not to navigate over docs, but over the platform. For the local development, platform is running at localhost:3000 and docs at localhost:3001.

Principals to follow:
1) There is no need to document obvious things and what's visible on the UI.
2) Describe main concepts, principals, dependencies.
3) Provide examples, who and for what could use the specified piece.
4) Good docs are short docs. Make them very-very consize.
5) Don't use emojis, write in simple and straightforward manner.
6) Don't add "Future Considerations", or general "Best Practices".

Strong rules:
1) Never edit the comment at the top of the file <!-- --> That's your prompt.
2) The rest of the file should be built strictly following the prompt at the top comment.