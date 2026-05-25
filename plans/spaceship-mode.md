# Spaceship Mode — 설계 및 구현 계획

## 1. 목적

기존 "신의 시점" 시뮬레이션에 **우주선 조종 모드**를 추가한다.
플레이어가 직접 우주선을 타고 시뮬레이션 안을 항행하며, 별에 접근하면
그 별 주위에 행성계가 절차적으로 생성된다. 방문한 별과 행성은 **포켓몬
도감처럼 영구 기록**되며, 항행 중에는 우주의 시간 흐름이 달라진다.

## 2. UX 흐름

```
[시뮬 모드]                                [우주선 모드]
  ─────────                                  ───────────
  OrbitControls                              ShipController (WASD + 마우스룩)
  카메라가 박스 전체 조망                     1인칭/3인칭 토글 (V)
  시간 슬라이더로 우주시간 전진               우주선 좌표/속도 HUD (기즈모 포함)
  도구로 별/BH 배치                           별 근접 → 행성계 생성 + 도감 등록
                                              ESC → 인게임 메뉴 (도감/설정/탈출)
                                              J → 워프 차지 (도감의 별로 점프)
       ↑                                            ↑
       └──── 상단 툴바: [🚀 우주선] 버튼으로 토글 ────┘
```

전환 시 카메라 포즈는 보존된다. 시뮬 모드로 돌아가면 OrbitControls가
우주선 현재 위치를 새 타겟으로 잡는다 (또는 직전 타겟으로 복귀 — 옵션).

## 3. 시간 모델 (가장 중요한 설계 결정)

두 개의 시계를 분리한다:

| 시계 | 의미 | 어디서 쓰이나 |
|---|---|---|
| `cosmicTime` | 우주의 나이 (= 현재 `sim.simTime`) | 별 형성/소멸/팽창/이벤트 |
| `shipProperTime` | 조종사의 시계 (벽시계 1:1) | HUD, 컨트롤러 적분 |

### 모드별 클럭 동작

- **시뮬 모드** (현재 동작): 매 프레임 `cosmicTime` 이 `timeScale × substeps × INTERNAL_DT` 만큼 전진. `shipProperTime` 미사용.
- **우주선 모드 (준광속)**: 우주선이 정지/저속이면 시간 슬라이더가 그대로 cosmicTime을 굴린다 (별 주변에 머무르며 별의 일생을 관찰 가능). 우주선의 throttle이 올라갈수록 `cosmicTime` 의 흐름은 자동으로 감속한다 (관찰자가 빨리 움직일수록 외부 변화를 덜 보는 게임적 표현). 식: `cosmicSpeedMultiplier = lerp(1.0, 0.05, throttle)`.
- **워프 모드**: cosmic clock 완전 정지 ("워프 버블" 핸드웨이브). `shipProperTime`만 벽시계로 흐른다. 워프 종료 시 우주는 출발 시점 그대로 + 워프에 걸린 ship time만큼만 보정. HUD에 `WARP: cosmic time frozen` 배지.

상대성/비과학성에 대한 양심선언은 도감 도움말에 한 줄 적어두자
("워프는 게임적 편의이며 실제 물리를 따르지 않습니다").

### 구현 후크

`main.ts` 의 시뮬레이션 스텝 루프를 `ModeManager` 라는 작은 객체에
위임한다. `ModeManager.tick(wallDt)` 가 반환:

```ts
{
  simSteps: number,   // 이번 프레임에 sim.step() 호출할 횟수
  simDt: number,      // 각 호출에 넘길 dt
  shipDt: number,     // ShipController 적분에 쓸 dt
}
```

이 구조라면 시뮬 모드 ↔ 우주선 모드 ↔ 워프 모드 전환이
**기존 sim/scene 코드 변경 없이** 하나의 지점에서 결정된다.

## 4. 아키텍처

```
src/
  ship/
    ShipController.ts      WASD + 마우스룩 + 롤 + 스로틀; quaternion 기반
    ShipHUD.ts             좌표/속도/스로틀/근접별 거리 오버레이
    ModeManager.ts         시간 모드 분기 (시뮬/준광속/워프)
    PlanetSystem.ts        별 id → 결정론적 행성계 (시드 PRNG)
    StarSystemRenderer.ts  방문 중인 별의 행성 인스턴스드 메시
    Dex.ts                 별 + 행성 도감 (LRU 메모리 + localStorage)
  render/
    Scene.ts               (변경) 컨트롤러 모드 토글 노출
  ui/
    Layout.ts              (변경) 툴바에 🚀 토글, 도감 탭
  main.ts                  (변경) 루프를 ModeManager로 위임
```

### Effector에 안정적 id 필요

행성계 시드와 도감 키로 쓸 `id: number` 필드를 `Effector`에 추가한다.
`Simulator` 가 단조 증가 카운터로 발급. 형성 경로(`addEffector`, 별 형성)
모두에서 채워야 한다.

## 5. 행성계 생성 규칙 (Phase 2)

- 시드: `hash(effector.id)` → `mulberry32` PRNG
- 행성 개수: `3 + rand(5)` (분광형이 작을수록 가짓수 다양)
- 궤도 반경: 별 반경의 `2.5 ~ 18` 사이 로그 분포
- 색/크기: 궤도 반경 기반 추정 (안쪽=암석/뜨거움, 바깥=가스/얼음)
- 공전 주기: 케플러 ∝ a^1.5 (시각적 효과만, 실제 중력 계산 X)
- 위상: 시드에서 결정 → 매 방문 시 같은 위치에서 시작
- 행성 위치는 매 프레임 `shipProperTime` 기반으로 회전 (cosmicTime과 무관 — 별의 일생과 행성 공전을 분리)

## 6. 도감 (Phase 3)

두 종류:
- **별 도감**: 방문한 별 (id, 이름, 분광형, 방문 시 cosmicTime, 마지막 위치)
- **행성 도감**: `(starId, planetIndex)` 단위 (이름은 `Kepler-{starId}-{idx}` 식 자동 발급, 색/반경/궤도)

### 저장 계층

```
   메모리 LRU (~128 별 시스템 메시)   ←  생성/Dispose 자동
        ↑
   세션 메모리 (모든 방문 별/행성 메타데이터)
        ↑
   localStorage (영구 도감, JSON)
```

LRU 는 메시 메모리만 캐핑한다. 도감 메타데이터는 가볍기 때문에
풀(full) 보관해도 OK (방문 10,000 별까지는 수 MB 수준).

## 7. 워프 (Phase 4, 선택)

- 도감 화면에서 별 선택 → "워프" 버튼
- 워프 차지(2초) → 카메라가 목적지로 보간 (3초)
- 동안 cosmic clock 정지, 별 사이의 잔별/은하 페어가 휙 지나가는 streak 셰이더로 분위기
- 종료 시 목적지 별 근접 (PlanetSystem 자동 생성)

## 8. 단계별 구현 계획

### Phase 0 — 준비 (스카이박스 버그 선제 해결)
0. 별무리/네뷸라가 **카메라를 따라다니도록** 부모 그룹을 만들고 매 프레임 `group.position = camera.position` 으로 갱신. 배경 그라데이션을 단일 어두운 색으로 단순화 (방향성 제거). 우주선 모드 사방 시야에 어두운 면이 생기는 문제 해결.

### Phase 1 — 셸 (이 PR)
1. `Effector.id` 추가 + Simulator에서 발급
2. `src/ship/ModeManager.ts` — 시간 분기 후크
3. `src/ship/ShipController.ts` — WASD + Pointer Lock + 1/3인칭
4. `src/ship/ShipHUD.ts` — HTML 오버레이 (좌표/속도/스로틀 + 화면 우상단 미니 축 기즈모)
5. `index.html` 툴바에 🚀 버튼 + 우주선 HUD DOM
6. `Scene.ts` 에 컨트롤러 모드 토글 메서드
7. `main.ts` 가 ModeManager 사용하도록 리팩터

### Phase 2 — 행성계 + LRU
8. `src/util/LRU.ts`
9. `src/ship/PlanetSystem.ts` (시드 PRNG + 행성 메타 생성)
10. `src/ship/StarSystemRenderer.ts` (인스턴스드 행성 메시, dispose)
11. ShipController가 매 프레임 근접 별 검출 → 생성/언로드

### Phase 3 — 도감 + 인게임 메뉴
12. `src/ship/Dex.ts` (메모리 + localStorage)
13. ESC 인게임 메뉴 모달 (별 탭 / 행성 탭 / 설정 / 시뮬로 복귀)
14. 도감 항목 클릭 → 카메라가 그 별/행성으로 부드럽게 이동

### Phase 4 — 워프 (선택)
15. 워프 차지/streak 셰이더 / cosmic time freeze

## 9. 미해결 질문 / 결정

- [ ] 우주선의 시작 위치: 박스 중앙? 가장 가까운 별 옆?
  → **결정**: 박스 중앙. 첫 워프 가이드 메시지 표시.
- [ ] 우주선 모드 진입 시 시뮬을 일시정지할까?
  → **결정**: 아니오. cosmicTime은 새 모델로 계속 흐른다.
- [ ] 1인칭 카메라에서 우주선 모델 렌더링?
  → **결정**: Phase 1은 카메라만. 3인칭에서 단순한 화살표/원뿔 메시.
- [ ] 도감 데이터를 별이 죽으면 어떻게?
  → **결정**: 별의 메모리 LRU 슬롯은 비우되, 도감 메타데이터는 보존
    ("이 별은 더 이상 존재하지 않습니다" 표시).
