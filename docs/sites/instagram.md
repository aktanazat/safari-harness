---
name: Instagram
hosts: instagram.com, www.instagram.com
---
# Instagram

Public profiles and posts read in Safari as the signed-in user sees them. Notes from 10-23.

## Profiles
- A profile is `www.instagram.com/<user>/`. Wait on the selector `a[href*="/p/"]` (a post's link): a text wait on the user name returned before the grid drew, with no posts on the page.
- The grid starts with 12 posts; `scroll {to: "bottom"}` adds about 12 each time and drops the first rows from the page, so read the posts after every scroll and keep each link once. Posts are `/p/` and `/reel/` links, some of them on other accounts (collaborations).
- A grid image's `alt` is the post's whole caption.

## Posts
- A post is `www.instagram.com/<user>/p/<code>/` (or `/p/<code>/`). It has no h1 and its title is "Instagram": wait on the selector `main time[datetime]` (under 1 s in `map` on 10-23). That first `time` is the post's date; later ones are comments'.
- `meta[name=description]` holds `<likes>, <comments> - <user> on <date>: "<caption>"`.
- A carousel has only its loaded slides in the page; `main button[aria-label=Next]` shows there are more, and clicking it loads the next.
- No post read on 10-23 (7 from nasa, natgeo, natgeotravel) had a location link (`/explore/locations/`).

## Readers
Shipped with the harness; run with `eval {tab, reader}` or `map {urls, what: "eval", reader}`.
- `profile`: `user`, the profile's description line, and `posts` (url, caption, image) on the page now; run it after each scroll.
- `post`: url, user, counts, date, caption, the loaded images, `video`, and `more` (more carousel slides behind Next).
