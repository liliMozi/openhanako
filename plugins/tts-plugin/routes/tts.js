const VOICES = [
  { id: "zh_female_vv_uranus_bigtts", name: "Vivi 2.0", lang: "zh", desc: "通用女声" },
  { id: "saturn_zh_female_cancan_tob", name: "知性灿灿", lang: "zh", desc: "角色扮演" },
  { id: "saturn_zh_female_keainvsheng_tob", name: "可爱女生", lang: "zh", desc: "角色扮演" },
  { id: "zh_female_xiaohe_uranus_bigtts", name: "小何", lang: "zh", desc: "通用女声" },
  { id: "en_male_tim_uranus_bigtts", name: "Tim", lang: "en", desc: "英文男声" },
];

export default function (app, ctx) {
  app.get("/voices", async (c) => {
    return c.json({ voices: VOICES, config: ctx.config.get() || {} });
  });

  app.put("/config", async (c) => {
    try {
      const body = await c.req.json();
      for (const [key, value] of Object.entries(body)) {
        ctx.config.set(key, value);
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/credentials", async (c) => {
    try {
      const creds = await ctx.bus.request("tts:get-credentials");
      return c.json(creds);
    } catch (err) {
      return c.json({ appId: "", accessToken: "", resourceId: "seed-tts-2.0" });
    }
  });

  app.put("/credentials", async (c) => {
    try {
      const body = await c.req.json();
      const result = await ctx.bus.request("tts:set-credentials", body);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });
}
