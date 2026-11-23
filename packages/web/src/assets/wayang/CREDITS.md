# Wayang Kulit & Gunungan Artwork Credits

The articulated SVG silhouettes in `paths.ts` (`Semar`, `Bima`, `Arjuna`, `Gatotkaca`, `Kresna`) and the `Gunungan` (Kayon) outer silhouette are traced and joint-segmented derivatives of archival photographs from the **Tropenmuseum** (part of the **Nationaal Museum van Wereldculturen / Wereldmuseum**, Amsterdam), published on Wikimedia Commons under the **Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0)** licence.

The `Srikandi` silhouette in `paths.ts` is instead traced from a different source, a printed plate from the **KITLV** collection (Leiden University Libraries) by **Raden Soelardi**, published on Wikimedia Commons under **CC BY 4.0**; see the table below.

## Sources

| Figure | Role in DALANG | Catalog Number | Wikimedia Commons File | Licence |
| --- | --- | --- | --- | --- |
| **Semar** | Lead | `TMnr 8-251` | [COLLECTIE TROPENMUSEUM Wajang kulit pop voorstellende Semar TMnr 8-251.jpg](https://commons.wikimedia.org/wiki/File:COLLECTIE_TROPENMUSEUM_Wajang_kulit_pop_voorstellende_Semar_TMnr_8-251.jpg) | CC BY-SA 3.0 |
| **Bima** | Coder | `TMnr 8-265` | [COLLECTIE TROPENMUSEUM Wajang kulit pop voorstellende Bima TMnr 8-265.jpg](https://commons.wikimedia.org/wiki/File:COLLECTIE_TROPENMUSEUM_Wajang_kulit_pop_voorstellende_Bima_TMnr_8-265.jpg) | CC BY-SA 3.0 |
| **Arjuna** | Reviewer | `TMnr 8-307` | [COLLECTIE TROPENMUSEUM Wajang kulit pop voorstellende Raden Arjuna TMnr 8-307.jpg](https://commons.wikimedia.org/wiki/File:COLLECTIE_TROPENMUSEUM_Wajang_kulit_pop_voorstellende_Raden_Arjuna_TMnr_8-307.jpg) | CC BY-SA 3.0 |
| **Kresna** | Coder (complex tasks) | `TMnr 8-239` | [COLLECTIE TROPENMUSEUM Wajang kulit pop mogelijk voorstellende Kresna TMnr 8-239.jpg](https://commons.wikimedia.org/wiki/File:COLLECTIE_TROPENMUSEUM_Wajang_kulit_pop_mogelijk_voorstellende_Kresna_TMnr_8-239.jpg) (the museum catalogues it as "possibly Kresna") | CC BY-SA 3.0 |
| **Gatotkaca** | Coder (medium tasks) | `TMnr 8-273` | [COLLECTIE TROPENMUSEUM Wajangfiguur van perkament voorstellende Gatot Kaca TMnr 8-273.jpg](https://commons.wikimedia.org/wiki/File:COLLECTIE_TROPENMUSEUM_Wajangfiguur_van_perkament_voorstellende_Gatot_Kaca_TMnr_8-273.jpg) | CC BY-SA 3.0 |
| **Srikandi** | QA | KITLV `36C99` | [Sikandi, KITLV 36C99 (cropped).tiff](https://commons.wikimedia.org/wiki/File:Sikandi,_KITLV_36C99_(cropped).tiff), plate "Sikandi" by Raden Soelardi (Topografische Inrichting), KITLV / Leiden University Libraries. Traced and joint-segmented from the plate. | CC BY 4.0 |
| **Gunungan (Kayon)** | Emblem & Logo | `TMnr 8-225` | [COLLECTIE TROPENMUSEUM Wajangfiguur van perkament voorstellende een pauzeteken TMnr 8-225.jpg](https://commons.wikimedia.org/wiki/File:COLLECTIE_TROPENMUSEUM_Wajangfiguur_van_perkament_voorstellende_een_pauzeteken_TMnr_8-225.jpg) | CC BY-SA 3.0 |

## Licencing Split

- **Derived artwork** (`packages/web/src/assets/wayang/paths.ts`, `WayangFigure.tsx`, `Gunungan.tsx`, and `packages/web/public/favicon.svg`): licensed under **CC BY-SA 3.0** (https://creativecommons.org/licenses/by-sa/3.0/), carrying the attribution and ShareAlike terms of the Tropenmuseum source photographs. The `Srikandi` shapes additionally require attribution to Raden Soelardi / KITLV (CC BY 4.0, which permits adaptation and relicensing under these terms with credit kept).
- **DALANG source code**: remains licensed under the **MIT Licence** (see root `LICENSE`).
