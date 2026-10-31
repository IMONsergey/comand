# Comand interface provenance

The interface adapts the owner's actual Apcosys component sources, inspected on 2026-10-31 from the extracted Apcosys design system reference (`IMONsergey/APCOCLEAR2`; token manifest verified against `IMONsergey/apcoweb/main`, version 2.1.0).

- `src/design-system.tsx`: `SaasButton` and `SaasField` retain the semantics, prop contract, busy/disabled behavior and accessible field IDs of Apcosys `saas/primitives.tsx`. `DoubleButton` retains the two-shape / one-action structure of `components/ui/DoubleButton.tsx`. Comand uses local Lucide icons and an accessible lightweight loader in place of the Apcosys visual loader dependency.
- `src/product.css`: neutral semantic surface/text roles, control radius 5px, panel radius 7px, 4/8/12/16/24/32 spacing and cubic-bezier easing are adapted from `styles/tokens.css` and `tokens/apcosys.tokens.json`. Accent roles are deliberately remapped to Comand red. IBM Plex Sans supplies Russian UI typography; IBM Plex Mono is retained for code and metadata.
- Product screens consume live API state. No Apcosys demo data, fictional devices, fake execution results or unsupported mail delivery were imported.

Native select controls remain for robust keyboard and mobile interactions. Recovery codes are transient React state; they are never written to browser storage.
