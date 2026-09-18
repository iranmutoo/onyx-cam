export default {
  async fetch(r) {
    return new Response("site OK", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
};
