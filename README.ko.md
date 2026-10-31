# SimRep-Web

[English](README.md) | [SimRep](https://github.com/leeseunguk/SimRep)

Rust 이온 광학 코어를 브라우저 WebAssembly 워커에서 실행합니다. 형상 생성,
전위 계산, 입자 비행은 계산 서버 없이 로컬에서 수행됩니다.

## 구성과 빌드

`simrep/`은 실제 SimRep 서브모듈이며
`6d2dd8c813541a012afa21023a4c555fd991d25a`로 고정되어 있습니다.
`crates/simrep-wasm/`은 계산 래퍼, `app/`은 데스크톱 명령 어댑터,
`web/`은 UI와 IPC 워커입니다. UI 소스의 기본 위치는 `simrep/app/src`이고
개발 시 `SIMREP_APP_SRC`로 바꿉니다.

```sh
git clone --recurse-submodules <repository-url>
cd <checkout>
bash scripts/build.sh
```

Rust는 rustup으로 설치하고 Node.js와 npm도 설치하세요. 스크립트는 wasm32
타깃과 wasm-bindgen-cli 0.2.129를 준비하고 직렬/스레드 wasm 및 UI를 빌드하여
최상위 `dist/`를 만듭니다. 스레드 빌드는 nightly-2025-11-15를 사용합니다.
서브모듈 업데이트, 검증 명령과 정적 호스팅은 [RELEASE.md](docs/RELEASE.md)에 있습니다.

## 기능과 제한

PA/PA#/PA0 및 fast-adjust, 리터럴 GEM과 상대 include/STL, STL/OBJ/PLY/3MF/glTF/GLB,
계단형/정확한 표면 CPU f64 계산, RK45/Boris 비행, ION/리터럴 FLY2,
균일 자기장/자기 PA/코일, 메모리 기반 과학 데이터 내보내기를 제공합니다.
Einzel, quadrupole, reflectron, trap 템플릿과 형상 검사 및 aligned/cut-cell
형상 빌드를 지원합니다. IOB는 경계와 배치를 읽으며 Lua를 실행하지 않습니다.
실행 Lua, STEP/IGES CAD, 결합 공간 전하, 가스 충돌, 네이티브 파일시스템 및
AI 기능은 브라우저에 노출하지 않습니다.

멀티코어는 최대 4개 Rayon 워커를 사용하며 COOP `same-origin`, COEP
`require-corp`와 HTTPS 또는 localhost가 필요합니다. 격리가 없으면 직렬
패키지의 워커 1개로 대체하고 이유를 보고합니다. 실제 초기화된 개수를 확인하세요.
사용자 지정 헤더가 없는 호스트를 위해 coi-serviceworker도 포함합니다.
WebKit은 중첩 스레드 모듈 워커의 시작/새로고침이 간헐적으로 멈추므로 기본적으로
직렬 패키지의 CPU f64 워커 1개를 사용합니다. WebKit의 명시적 다중 스레드
요청은 실험적이며 지원하는 기본 경로는 워커 1개와 IndexedDB 저장소입니다.

## 브라우저 지원

| 브라우저 | 계산 및 UI | 3D 뷰 | 검증 범위 |
| --- | --- | --- | --- |
| Chrome/Edge 113+ | CPU WebAssembly, 최대 워커 4개 | 사용 가능한 WebGPU 필요 | Chromium 자동화, Edge 별도 미검증 |
| Safari | CPU WebAssembly, 기본 워커 1개 | 지원하는 대체 경로에서는 비활성 | Linux WebKitGTK 검증, 실제 Safari 아님 |
| Firefox | CPU WebAssembly | 지원하는 대체 경로에서는 비활성 | 이번 릴리스에서 미검증 |

3D 뷰에는 WebGPU가 필요합니다. Safari/Firefox에서는 3D 뷰 없이 계산을
사용합니다. WebGPU 가용성은 장치와 브라우저 정책에도 달려 있습니다.
Linux WebKitGTK 결과는 실제 Safari 플랫폼 호환성을 증명하지 않습니다.

GPU 계산은 simrep-fly의 공개 필드 내보내기가 제공될 때까지 앱에서
비활성화되어 있습니다. 실험적 WebGPU API의 커널은 f32이며 외부 반복과
잔차는 CPU f64입니다. [GPU API](docs/webgpu.md), [CPU 계약](docs/web-contract.md)을
참고하세요. 삼각함수를 사용하는 형상/회전 격자는 네이티브와 wasm 사이
최대 2 ULP 차이가 날 수 있어 엄격한 OBJ 바이트 동일성은 알려진 예외입니다.

## 검증

```sh
(cd web && npm run typecheck && npm test)
(cd web && npx playwright install chromium webkit)
(cd web && npm run e2e -- --project=chromium)
```

Linux에서 추출한 WebKit 의존성 번들을 사용하는 경우 실제 설치 경로를 지정합니다.
호스트 검증 생략만으로 라이브러리가 설치되지는 않습니다.

```sh
export PLAYWRIGHT_BROWSERS_PATH=/path/to/playwright-browsers
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
export LD_LIBRARY_PATH=/path/to/webkit-root/usr/lib/x86_64-linux-gnu
(cd web && npm run e2e -- --project=webkit)
```

네이티브/Node 및 Chromium 바이트 동일성 명령은 [English README](README.md)에
있습니다. 실제 wasm과 네이티브 결과, 동작 로그와 스크린샷을 무시되는
`evidence/`에 저장합니다. 프런트엔드 Playwright는 실제 React UI를 검증하며
백엔드 검증만으로 제품 UI의 동작을 증명하지 않습니다.
이전 통합 결과는 [검증 기록](docs/integration-verification.md)에 있습니다.

## 라이선스

[LICENSE](LICENSE)의 PolyForm Noncommercial 1.0.0을 사용합니다.
의존성은 각자 라이선스를 유지합니다. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요.
