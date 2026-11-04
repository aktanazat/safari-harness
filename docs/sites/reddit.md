---
name: Reddit
hosts: reddit.com, old.reddit.com
---
# Reddit

Reddit blocks reads from outside a browser. Read it through the user's signed-in Safari session, and read it once.

## Reading
- `read` of Reddit pages gets "You've been blocked by network security. To continue, log in to your Reddit account or use your developer token". `read` of `old.reddit.com` goes to `/login/?reason=lor2`, and `read` of a `.json` address returns about 150 characters.
- What worked: one signed-in `https://www.reddit.com/` tab and cookie-bearing `fetch` from it:
  - a thread: `/r/<sub>/comments/<id>.json?limit=500&raw_json=1`
  - search: `/r/<sub>/search.json?q=<words>&restrict_sr=1`
  Four to eight threads per `eval` (or `repl` script) is a good batch.
- Scraping `old.reddit.com` pages in Safari also worked, but each thread cost one large `eval`; the JSON is cheaper.
- Save each thread's text to a file as you fetch it and work from the files. One session fetched 49 threads 300 times, mostly again after its context was summarized.
