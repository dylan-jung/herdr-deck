# herdr-deck

Ulanzi Stream Deck(D200X)에서 [herdr](https://herdr.dev) 코딩 에이전트 세션을 제어하는 Ulanzi Studio 플러그인.
키 입력 시뮬레이션 없이 **herdr 소켓 API만** 사용하므로 한영키·포커스·창 위치와 무관하게 동작한다.
멀티 세션 지원: 덱 페이지마다 다른 herdr(로컬 / SSH 원격 서버)를 제어한다.

## 기능

| 액션 | 동작 |
|---|---|
| **Space 1~5** | 프로젝트(메인 스페이스) 상태를 색으로 표시 — 회색 없음 / 초록 idle / 노랑 working / 빨강 blocked / 파랑 done. 워크트리 스페이스는 번호에서 제외하되 상태는 부모 프로젝트에 합산. 누르면 blocked 에이전트 → 가장 가까운 에이전트(메인→워크트리 순) → 스페이스 순으로 점프. 없는 번호는 현재 pane 폴더를 루트로 자동 생성 |
| **세로/가로 분할, 창 닫기, 줌** | `pane.split` / `pane.close` / `pane.zoom` |
| **호출 응답** | blocked(응답 대기) 에이전트로 즉시 점프, 없으면 idle → working 순 |
| **새 워크트리** | `git worktree` + 새 스페이스 생성 후 이동 (`agent-MMDD-HHMMSS` 브랜치). 현재 스페이스가 repo가 아니면 pane 폴더로 repo 스페이스를 만들어 재시도 |
| **워크트리 정리** | 현재 워크트리 스페이스 제거 (브랜치는 유지) |
| **Lazygit** | 새 탭을 열어 lazygit 실행 |
| **노브: herdr 탭** | 회전 = 이전/다음 탭, 누름 = 새 탭, 누른 채 왼쪽 회전 = 탭 닫기 |
| **노브: 에이전트** | 회전 = 에이전트 순회(세션 전체), 누름 = 호출 응답 |
| **노브: 스페이스** | 회전 = 스페이스 순회, 누름 = 새 스페이스 |
| **세션 표시** | 페이지가 제어하는 호스트 표시등 (큰 블록 배경 이미지는 `resources/label_*_wide.png`) |

실패한 동작은 herdr 에러 메시지가 토스트로 표시된다.

## 설치

레포는 아무 데나 클론하고, `npm run deploy`로 Plugins 폴더에 **빌드된 복사본**을 설치한다
(심링크가 아니므로 레포를 옮기거나 지워도 설치본은 그대로).

```bash
git clone https://github.com/dylan-jung/herdr-deck ~/dev/personal/herdr-deck
cd ~/dev/personal/herdr-deck
npm install
npm run deploy     # esbuild 번들 → Plugins/com.ulanzi.herdrstatus.ulanziPlugin 설치 → Ulanzi Studio 재시작
```

- 업데이트: `git pull && npm run deploy`
- `npm run build`는 `.dist/`에 번들만 만든다. 재시작 없이 설치만 하려면 `npm run deploy -- --no-restart`
- 설치본의 `sessions.json`은 덮어쓰지 않는다 (첫 설치 때만 레포 것을 복사). 세션 설정은 설치본에서 고친다
- 설치 대상 폴더명·포함 파일·보존 파일은 `package.json`의 `ulanzi` 항목에서 정한다 (`scripts/deploy.mjs`는 플러그인 무관)

Ulanzi Studio를 재시작하면 사이드바 "Herdr" 카테고리에 액션들이 나타난다.
기본 3페이지 프로필을 쓰려면 `tools/gen_herdr_profile.py`의 `PROFILE_ID`를 자기 프로필 폴더 ID로 바꾼 뒤 실행.

## 세션 설정 — `sessions.json` (설치본: `Plugins/com.ulanzi.herdrstatus.ulanziPlugin/sessions.json`)

```json
{
  "sessions": {
    "remote": { "host": "my-server", "remote_sock": "/home/me/.config/herdr/herdr.sock" },
    "gpu-box":  { "host": "gpu-box", "remote_sock": "/home/me/.config/herdr/herdr.sock" }
  }
}
```

- `local`은 항상 존재하며 `~/.config/herdr/herdr.sock`을 사용
- `host`는 SSH config에 있는 이름 그대로 (BatchMode로 붙으므로 키 인증 필요)
- `remote_sock`은 **절대경로** (ssh 유닉스 소켓 포워딩 제약)
- 버튼의 `ActionParam.session`이 이 이름을 참조 → 서버 교체는 이 파일 수정으로 끝
- 30초마다 자동 리로드. 파일이 깨지면 마지막 정상 설정 유지, 모르는 세션의 버튼은 실행 거부(로컬로 폴백하지 않음)

원격 세션은 플러그인이 SSH 유닉스 소켓 터널(`~/.config/herdr/deck-<name>.sock`)을 자동 생성·재연결·정리한다.
원격 서버 준비: `ssh <host> 'herdr server'` (헤드리스) 또는 한 번 `herdr --remote <host>`로 접속.

## 구조

```
manifest.json           # 액션 정의 (아이콘·이름·States)
plugin/app.js           # 전체 로직 (Node, 앱 내장 런타임으로 실행)
plugin/libs/            # Ulanzi plugin-common-node (vendored)
resources/              # 전 아이콘 (Pillow 스크립트로 생성한 PNG)
sessions.json           # 세션(호스트) 설정
scripts/deploy.mjs          # 빌드(esbuild)·설치·재시작
tools/gen_herdr_profile.py  # 3페이지 프로필 생성기 (앱/사용자 항목은 보존)
```

### 동작 노트

- 버튼 식별: 액션 UUID에서 기능을, 프로필 파일에서 세션을 읽는다 (앱이 이벤트에 설정을 안 실어주는 경우 대비 이중화)
- 스페이스 아이콘은 숫자가 구워진 PNG를 `setPathIcon`으로 교체 (이 앱 버전은 플러그인 아이콘 위 텍스트 렌더링을 지원하지 않음)
- 세션별 직렬 큐 + 노브 연타 백프레셔, 폴링 재진입 가드
- 앱 연결이 끊기면 프로세스와 터널을 스스로 정리 (좀비 방지)

### 개발 시 주의

**라이브 Ulanzi Studio(포트 3906)에 테스트 인스턴스를 접속시키지 말 것** — 같은 UUID로 접속하면
등록이 새 연결로 넘어가서 진짜 플러그인이 이벤트를 못 받는다. 구문 검증은 `node --check`까지만.
플러그인만 재시작하려면 프로세스를 죽이고 같은 인자로 다시 실행하면 앱이 버튼 등록을 재전송한다:

```bash
"/Applications/Ulanzi Studio.app/Contents/MacOS/NodeJS/node" plugin/app.js 127.0.0.1 3906 ko-KR
```
