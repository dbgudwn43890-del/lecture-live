import type { MetadataRoute } from "next";
import { INDEXABLE_PATHS, SITE_ORIGIN, publicPagePair } from "./lib/site-seo";

export default function sitemap(): MetadataRoute.Sitemap {
  return INDEXABLE_PATHS.map(path => {
    const pair = publicPagePair(path)!;
    return {
      url: `${SITE_ORIGIN}${path}`,
      alternates: { languages: { ko: `${SITE_ORIGIN}${pair.ko}`, en: `${SITE_ORIGIN}${pair.en}` } },
    };
  });
}
