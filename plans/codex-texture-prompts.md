# Codex 행성 텍스처 생성 프롬프트

지구·화성은 실측 위성 맵을 직접 받았다(`scripts/fetch-textures.sh`).
이 문서는 **실측 맵이 없는 "다른 행성"** — 우주선 모드가 절차생성하는 외계
행성 6종, 그리고 화성 기복(normal/height) 보강 — 을 Codex(이미지 AI)로 만들
때 쓰는 프롬프트 모음이다.

## 0. 모든 행성 텍스처 공통 규칙 (반드시 프롬프트에 포함)

행성 표면 텍스처는 구(sphere)에 입히는 **정거형(equirectangular) 맵**이다.
일반 풍경 이미지와 제약이 다르다:

- **비율 2:1**, 4096×2048 (히어로용 8192×4096). 정확히 가로=세로×2.
- **가로 이음매 연속**: 이미지 왼쪽 끝과 오른쪽 끝이 매끄럽게 이어져야 함
  (경도 0°=360°). seam이 보이면 구에 세로줄이 생긴다.
- **극 수렴 인지**: 위/아래 가장자리(=북극/남극)는 한 점으로 수렴하므로
  디테일을 몰아넣지 말 것. 위아래 10%는 단순하게.
- **albedo(색) 맵에는 조명/그림자/하이라이트/대기 글로우를 굽지 말 것.**
  렌더러가 실시간 조명을 한다. 평평한 정오광 상태의 순수 표면색만.
- **카메라/원근/행성 외곽선(검은 배경 속 동그란 행성) 금지.** 표면을 펼친
  평면 맵이지 "우주에 떠 있는 행성 사진"이 아니다.
- 텍스트·워터마크·테두리 없음.

공통 negative prompt:
```
spherical planet, globe, 3d render of a planet, black space background, circular
vignette, baked shadows, baked lighting, sun glare, atmospheric glow, terminator
line, camera perspective, horizon, clouds floating above surface, text, watermark,
border, seams, visible left-right discontinuity, distorted poles
```

명명 규칙: `public/textures/exo/<class>_<map>_<res>.<ext>`
(예: `lava_color_4k.jpg`, `ice_normal_4k.png`). 색=JPG, normal/height=PNG.

---

## 1. 외계행성 6종 (절차생성 대체용 albedo)

각 클래스는 `src/ship/PlanetSystem.ts`의 `PlanetClass`와 1:1 대응. 현재는
GLSL 노이즈로 그리지만, 텍스처를 넣으면 `material.map`으로 교체 가능.
변종(variant)을 2~3장씩 만들면 같은 클래스라도 행성마다 다르게 보인다.

### lava (용암형) — `lava_color`
```
Equirectangular 2:1 texture map of a molten lava planet surface, top-down flat
map projection. Dark basaltic crust cracked by glowing orange-red magma rivers
in a branching network, cooled black volcanic plains, scattered bright yellow-hot
fissures. Even illumination, pure surface albedo, horizontally tiling, simple
near the top and bottom edges. 4096x2048.
```

### rock (암석형, 크레이터) — `rock_color`
```
Equirectangular 2:1 flat map of a barren cratered rocky planet, Mercury-like.
Grey-brown regolith, overlapping impact craters of varied sizes, ejecta rays,
ancient lava-flooded basins, subtle dust tonal variation. Even flat lighting,
albedo only, seamless horizontal wrap, smooth toward the poles. 4096x2048.
```

### desert (사막형) — `desert_color`
```
Equirectangular 2:1 flat map of an arid desert planet, Arrakis-like. Ochre, tan
and rust-red sand seas with long dune ridges, dried cracked basins, scattered
rocky plateaus and canyons, no water. Flat even illumination, pure albedo,
horizontally seamless, simplified poles. 4096x2048.
```

### ocean (해양형, 지구형 변종) — `ocean_color`
```
Equirectangular 2:1 flat map of an ocean world with scattered green-brown
continents and archipelagos, deep blue seas with lighter turquoise shallows
along coasts, small white polar ice. Earth-like but alien continent shapes.
Flat even daylight, albedo only, no clouds, seamless horizontal wrap,
converging poles. 4096x2048.
```

### ice (얼음형) — `ice_color`
```
Equirectangular 2:1 flat map of a frozen ice planet, Europa-like. Pale blue-white
ice crust laced with a network of reddish-brown linea (cracks/ridges), subtle
bluish fracture zones, sparse cratering. Flat even lighting, albedo only,
horizontally tiling, smooth poles. 4096x2048.
```

### gas (가스 거대행성) — `gas_color`
```
Equirectangular 2:1 flat map of a gas giant's banded atmosphere, Jupiter-like.
Horizontal cloud bands in cream, tan, ochre and rust, turbulent swirls and
festoons at band boundaries, one large oval storm. Bands run perfectly
horizontal and wrap seamlessly left-to-right; poles fade to smooth darker tone.
Flat even lighting, albedo only. 4096x2048.
```

> 가스 거대행성은 normal/height 불필요(기복 없음). 나머지 클래스는 아래 §2의
> 대응 normal 맵을 함께 만들면 명암 경계에서 기복이 산다.

---

## 2. 기복 맵 (normal / height) — 선택, 임팩트 큼

albedo와 **같은 좌표로 정렬**되어야 한다. 가장 안전한 방법:
**grayscale height 맵을 만들고** 코드/도구로 normal로 변환(예: ImageMagick
`-morphology Convolve Sobel` 또는 three.js에서 bumpMap 직접 사용).

height 맵 공통 프롬프트 접미:
```
... as a GRAYSCALE HEIGHT/ELEVATION map: white = high terrain, black = low,
smooth gradients, no color, matching the same equirectangular 2:1 layout.
```

- `rock_height`: 크레이터 림은 밝게, 분지 바닥은 어둡게.
- `desert_height`: 듄 능선 밝게, 분지 어둡게, 협곡 깊은 검정.
- `ice_height`: 능선(linea) 밝은 선, 균열 어두운 골.
- `lava_height`: 화산 솟음 밝게, 용암 평원 평탄(중간 회색).

---

## 3. 화성 기복 보강 — `mars_normal` / `mars_height`

Solar System Scope는 화성 색 맵만 제공한다(이미 받음). 기복은:

- **1순위(실측):** NASA Mars Trek / USGS MOLA DEM(고도 GeoTIFF) → height →
  normal 변환. Codex보다 정확. (`mars_height` 슬롯)
- **Codex 폴백(스타일라이즈):**
```
Equirectangular 2:1 GRAYSCALE HEIGHT map of Mars topography, top-down flat
projection. White = high, black = low. Show the Tharsis volcanic rise with three
aligned shield volcanoes and the towering Olympus Mons, the vast Valles Marineris
canyon system stretching east-west, the smooth low northern plains, and the
heavily cratered southern highlands. No color, smooth gradients, seamless
horizontal wrap, simplified poles. 4096x2048.
```

---

## 4. 환경/분위기 에셋 (Codex가 실측보다 자유로운 영역)

- `sun_glow.png` — 태양 글로우 스프라이트(정사각 1:1, 투명 PNG):
```
Soft radial glow sprite of a star: bright white-yellow core fading smoothly to
transparent at the edges, faint lens-flare rays, on a fully transparent
background. Square, centered, no planet, no text. 1024x1024 PNG with alpha.
```
- 은하수 배경은 실측(Solar System Scope `milkyway_bg`, 이미 받음)이 자연스럽다.

---

## 5. 검수 체크리스트 (생성 후)

- [ ] 정확히 2:1 비율인가
- [ ] 좌우 끝을 이어 붙였을 때 seam이 안 보이는가 (`magick in.jpg -roll +2048+0 out.jpg`로 확인)
- [ ] 행성 외곽선/검은 배경/구운 그림자가 안 들어갔는가
- [ ] 극(상하단)에 디테일이 과하지 않은가
- [ ] (height) 순수 회색조인가, 색이 안 섞였는가
