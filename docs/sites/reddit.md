---
name: Reddit
hosts: reddit.com, old.reddit.com
---
# Reddit

Reddit blocks reads from outside a browser. Read it through the harness's browser with the `reddit` global, and read each thread once.

## Reading
- `read` of Reddit pages gets "You've been blocked by network security. To continue, log in to your Reddit account or use your developer token". `read` of `old.reddit.com` goes to `/login/?reason=lor2`, and `read` of a `.json` address returns about 150 characters.
- The `.json` addresses answer 403 from a browser tab too (11-27, Ladybird, signed out). Reddit's own pages and the fragments they load still work, signed out included, which is what the global reads.
- Save each thread's text to a file as you fetch it and work from the files. One session fetched 49 threads 300 times, mostly again after its context was summarized.

## In browser repl
The `reddit` global reads Reddit from one background tab of its own, the way Reddit's pages do. It only reads: it never votes, posts, or joins. Requests go out at least 1 s apart, across every session; a 429 fails the call with `rate_limited`. A session's reads run one at a time, since a thread read moves the tab.
- `reddit.getThread(postUrlOrId, {sort, limit})`: the post (title, author, subreddit, score, upvote ratio, comment count, text or link) and up to `limit` comments (default 50) in the order `sort` gives: `top` (default), `best`, `new`, `controversial`, `old`, or `qa`. Takes a post or comment URL, a share link (`/r/<sub>/s/<code>`), a `redd.it` link, or an id. The first comments come from the thread's page, then the next top-level ones, then the replies Reddit folds; each comment has `depth`, and a reply its `parentId`. `more: true` says Reddit holds comments the read did not reach, reply chains it moved to a page of their own ("97 more replies") included.
- `reddit.search(query, {subreddit, sort, time, limit, cursor})`: posts in Reddit's order (title, url, subreddit, author, date, score, comment count), up to `limit` (default 25; Reddit sends about 7 a request). `sort` is `relevance` (default), `hot`, `top`, `new`, or `comments`; `time` is `hour`, `day`, `week`, `month`, `year`, or `all` (default). The answer's `nextCursor` reads on.

```js
const { results } = await reddit.search("claude code skills", { subreddit: "ClaudeAI", time: "month", limit: 10 });
const { post, comments, more } = await reddit.getThread(results[0].url, { limit: 100 });
console.log(post.title, post.comments, comments.length, more);
```
