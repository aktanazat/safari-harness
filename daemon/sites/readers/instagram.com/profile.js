({
  user: location.pathname.split("/")[1],
  description: document.querySelector("meta[name=description]")?.content,
  posts: [...document.querySelectorAll("main a[href*='/p/'], main a[href*='/reel/']")].map((a) => {
    const img = a.querySelector("img");
    return { url: a.href, caption: img?.alt, image: img?.src };
  }),
});
