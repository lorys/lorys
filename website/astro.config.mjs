// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
    site: "https://www.lorys.site",
    base: "/",
    trailingSlash: "always",
    i18n: {
        defaultLocale: 'fr',
        locales: ['fr', 'en'],
        routing: {
          prefixDefaultLocale: false, // /about (fr) et /en/about (en)
        },
    }
});
