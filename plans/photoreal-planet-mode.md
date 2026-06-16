# 정밀 행성 관측 모드 (Photoreal Planet Mode) — 설계 및 에셋 계획

## 1. 동기

기존 우주는 빅뱅~현재의 **입자 우주(sim 모드)** 와 무한 절차생성 행성을
방문하는 **우주선(ship) 모드**로 구성된다. 방대한 스케일 때문에 어떤
행성도 "진짜 천체" 수준의 디테일을 갖지 못하고, 표면이 결국 GLSL 노이즈
무늬에 머문다 (`src/ship/shaders/planet.ts`).

→ **지정된 실제 천체(지구, 화성)** 를 실사 위성 텍스처로 렌더링하는 별도
모드를 추가해 "디테일"을 확보한다. 절차생성 우주와 공존한다.

## 2. 결정 사항 (확정)

- **통합 방식**: 독립적인 4번째 모드. 툴바에 별도 진입 버튼. 입자 우주와
  분리된 깨끗한 쇼케이스 씬.
- **대상 천체 / 제작 순서**: **지구 먼저 → 화성**. 지구로 전체 텍스처
  파이프라인(낮/밤/구름/바다/노멀)을 완성한 뒤, 화성은 맵 일부만 추가.
- **해상도**: **4K(4096×2048) 기본 로드 + 8K(8192×4096) 옵션**(클로즈업
  품질 모드에서 스왑). 2K 폴백은 추후 모바일 대응 시.

## 3. 기존 코드 재사용

행성 머티리얼은 이미 `MeshStandardMaterial` 기반(`PlanetShader.ts`)이라
실사 텍스처를 표준 슬롯에 그대로 연결한다:

| 슬롯 | 텍스처 | 비고 |
|---|---|---|
| `material.map` | albedo (낮) | sRGB |
| `material.normalMap` | 지형 노멀 | linear |
| `material.roughnessMap` | 바다/육지 마스크 | linear, 물만 정반사 |
| `material.emissiveMap` | 밤 도시 불빛 | 밤쪽(1−N·L)에서만 |
| 별도 구름 셸 + `alphaMap` | 구름 | 표면보다 살짝 빠른 자전 |
| 기존 `shaders/atmosphere.ts` 셸 | 대기 림광 | 그대로 재사용 |

→ 절차적 `onBeforeCompile` 분기를 "실사 텍스처 사용" 플래그로 우회하는
경로만 추가하면 된다. 입자 시뮬레이터(`physics/`)는 무변경.

## 4. 에셋 매니페스트

배치 경로(Vite `public/` → 루트 서빙):
```
public/textures/earth/   public/textures/mars/   public/textures/env/
```
명명: `<body>_<map>_<res>.<ext>`  예) `earth_day_4k.jpg`, `earth_day_8k.jpg`.
전부 정거형(equirectangular) 2:1. 색상 맵 JPG(~q90), 데이터/알파 맵 PNG(무손실).

### 🌍 지구 (우선 제작)
| 파일 | 맵 | 슬롯 | 출처(공개 도메인 권장) |
|---|---|---|---|
| `earth_day_{4k,8k}.jpg` | 낮 albedo | `map` (sRGB) | NASA Blue Marble Next Gen / Solar System Scope |
| `earth_night_{4k,8k}.jpg` | 밤 불빛 | `emissiveMap` (sRGB) | NASA Black Marble |
| `earth_clouds_{4k,8k}.png` | 구름(회색→알파) | 구름 셸 `alphaMap` | Solar System Scope / NASA |
| `earth_ocean_mask_{4k,8k}.png` | 바다=흰 마스크 | `roughnessMap` (linear) | Solar System Scope spec map |
| `earth_normal_{4k,8k}.jpg` | 지형 노멀 | `normalMap` (linear) | 고도→노멀 변환 |
| `earth_height_{4k}.png` *(택1)* | 고도 회색조 | `bumpMap` 대안 | NASA SRTM/ETOPO |

### 🔴 화성 (2순위)
| 파일 | 맵 | 슬롯 | 출처 |
|---|---|---|---|
| `mars_color_{4k,8k}.jpg` | albedo | `map` (sRGB) | NASA Viking/MGS, Solar System Scope |
| `mars_normal_{4k,8k}.jpg` | MOLA→노멀 | `normalMap` (linear) | USGS / NASA Mars Trek (MOLA) |
| `mars_height_{4k}.png` *(택1)* | MOLA 고도 | `bumpMap`/displacement | MOLA DEM |

화성은 바다/도시불빛/두꺼운 구름 없음 → 맵 적음. 얇은 CO₂ 헤이즈는 대기 셸 틴트로.

### 🌌 환경 (선택, 임팩트 큼)
| 파일 | 맵 | 용도 | 우선 |
|---|---|---|---|
| `milkyway_bg_{4k,8k}.jpg` | 은하수 파노라마 | 배경 스카이박스 | 중 |
| `moon_color_4k.jpg` + `moon_normal_4k.jpg` | 달 | 지구 옆 공전(스케일감) | 중 |
| `sun_glow.png` | 태양 글로우 스프라이트(방사형 알파) | 태양 방향 additive | 하 |

> Codex(이미지 AI)는 실측 맵의 빈 부분 보완·스타일라이즈 용도. 지구/화성
> 본체는 NASA/Solar System Scope 실측 맵이 정확도·일관성에서 월등.

## 5. 단계별 구현 (에셋 입수 후)

1. `SimMode`에 `'planet'` 추가 (`ship/ModeManager.ts`) + 툴바 진입 버튼.
2. `src/render/TextureLibrary.ts` — 4K/8K 스왑 로더 (sRGB/linear 색공간 지정).
3. `PlanetShader.ts` — `textured: true` 분기. 표준 맵 슬롯 연결, 밤 불빛은
   `emissiveMap × (1 − N·L)` 마스킹.
4. 구름 셸 메시(표면 1.01×, alphaMap, 독립 자전).
5. 지구 전용 씬 진입/이탈, OrbitControls 카메라.
6. 화성 프로파일 추가(맵만 교체).
7. (선택) 은하수 배경 + 달 + 태양 글로우.

## 6. 미해결 질문

- [ ] 모드 진입 시 입자 sim 일시정지? (ship 모드는 cosmic clock 동결)
- [ ] 달까지 넣을지 (지구 스케일감 ↑ vs 에셋·구현 비용)
- [ ] 8K 스왑 트리거: 카메라 거리 기반 자동 vs 품질 프리셋 수동
