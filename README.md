# Local Virtual PR

VS Code에서 로컬 AI 변경사항을 Pull Request처럼 검토하는 비공식 Codex companion extension입니다. 실제 소스 파일을 열어 Go to Definition, Go to Implementation, Find References 같은 언어 기능을 그대로 사용하면서 코드 줄에 리뷰 댓글을 남길 수 있습니다.

이 확장은 VS Code Marketplace에 게시되지 않습니다. 설치를 원하는 사용자가 GitHub Release의 VSIX를 직접 내려받아 설치하는 방식입니다.

## 주요 기능

- Git 기준 ref와 현재 working tree 사이의 Virtual PR 생성
- 변경 파일 목록과 diff 제공
- 파일별 Viewed 표시와 검토 진행률 제공
- 실제 source editor에서 심볼 탐색 지원
- 변경된 줄을 드래그하고 gutter `+`를 눌러 로컬 리뷰 댓글 작성
- 여러 리뷰 댓글을 같은 Codex 세션으로 전달
- Codex 답변을 원래 댓글 아래 답글로 표시
- 같은 댓글에서 후속 요청 전송
- 원본 리뷰 댓글과 리뷰어 후속 답글 편집
- AI가 코드를 수정해도 댓글 위치를 문맥으로 재탐색
- 사람이 직접 Resolve하고 로컬 승인

## 요구사항

- VS Code 1.96 이상
- Git 저장소로 열린 workspace
- 다음 중 하나:
  - OpenAI Codex VS Code extension
  - ChatGPT macOS 앱
  - `app-server`를 지원하는 최신 Codex CLI
- Codex를 사용할 수 있도록 로그인된 환경

## 설치

### VS Code 화면에서 설치

1. [Releases](https://github.com/djm07073/local-virtual-pr/releases/latest)에서 최신 `local-virtual-pr-*.vsix` 파일을 다운로드합니다.
2. VS Code에서 Extensions 화면을 엽니다.
3. 우측 상단 `...` 메뉴에서 **Install from VSIX...**를 선택합니다.
4. 다운로드한 VSIX를 선택합니다.
5. Command Palette에서 **Developer: Reload Window**를 실행합니다.

### 터미널에서 설치

```sh
code --install-extension ./local-virtual-pr-0.5.0.vsix
```

제거하려면:

```sh
code --uninstall-extension local.local-virtual-pr
```

## 사용 방법

### 1. Virtual PR 만들기

1. Git 프로젝트를 VS Code로 엽니다.
2. Activity Bar의 **Virtual PR** 아이콘을 엽니다.
3. **Virtual PR: Create or Reset**을 실행합니다.
4. 비교 기준 ref를 선택합니다. 비어 있으면 `origin/main`, `main`, `origin/master` 등을 순서대로 탐색합니다.

Virtual PR을 다시 생성하면 기존 로컬 리뷰 댓글과 연결된 Codex 세션 ID가 초기화됩니다.

### 2. 변경사항 검토하기

- 왼쪽 **Changes**에서 파일을 클릭하면 diff가 열립니다.
- 검토를 마친 파일은 파일 행의 체크 버튼 또는 우클릭 **Mark File as Viewed**로 표시합니다.
- Viewed 파일에는 체크 아이콘과 `Viewed` 문구가 나타나며, Changes 제목에서 `viewed/전체` 진행률을 확인할 수 있습니다.
- 다시 검토해야 하면 파일 행의 해제 버튼 또는 **Mark File as Unviewed**를 실행합니다.
- 심볼 탐색이 필요하면 파일의 **Open Navigable Source** 명령을 실행합니다.
- 실제 source editor에서는 다음 기능을 그대로 사용할 수 있습니다.
  - Go to Definition
  - Go to Implementation
  - Find References
  - Rename Symbol

### 3. 코드에 리뷰 댓글 달기

1. 오른쪽 working-tree 코드에서 변경된 줄을 좌클릭으로 드래그합니다.
2. 선택한 줄의 gutter에 나타나는 `+`를 클릭합니다.
3. 리뷰 내용을 입력하고 **Add Review Comment**를 누릅니다.

드래그만으로 댓글창이 자동으로 열리지는 않습니다. VS Code의 Comments API에 따라 드래그 후 gutter `+`를 한 번 클릭해야 합니다.

`+`가 보이지 않으면 **Virtual PR: Refresh**를 실행하고 diff 또는 source 파일을 다시 여세요. 우클릭 후 **Virtual PR: Add Review Comment**를 실행하는 방법도 사용할 수 있습니다.

작성한 원본 리뷰 댓글이나 후속 답글을 수정하려면 댓글 우측의 연필 버튼을 누릅니다. 원본 댓글은 왼쪽 Review comments 목록의 연필 버튼으로도 수정할 수 있습니다. Resolve된 댓글도 편집할 수 있으며 편집 후에도 Resolve 상태는 유지됩니다. Codex 답글은 수정할 수 없습니다.

### 4. Codex에 리뷰 전달하기

**Virtual PR: Send Review to AI**를 실행하면 해결되지 않은 댓글이 같은 Codex 세션으로 전달됩니다.

Codex는 다음 작업을 수행합니다.

1. 댓글의 파일, 줄, 선택 코드와 주변 문맥 확인
2. 현재 workspace 코드 수정
3. 관련 검증 실행
4. 각 리뷰 댓글 아래에 처리 내용과 검증 결과를 답글로 작성

Codex는 댓글을 자동으로 Resolve하지 않습니다.

### 5. 후속 요청하기

1. Codex 답글 아래의 댓글 입력란에 후속 요청을 작성합니다.
2. **Reply and Send to Codex**를 누릅니다.
3. 해당 댓글의 전체 대화가 같은 Codex 세션으로 전달됩니다.
4. Codex의 새 답글과 수정된 diff를 다시 검토합니다.

### 6. 리뷰 완료하기

- 만족한 댓글은 Virtual PR 트리에서 **Resolve Comment**로 직접 Resolve합니다.
- 모든 검토가 끝나면 **Virtual PR: Approve Locally**를 실행합니다.

로컬 승인은 메타데이터일 뿐이며 커밋, push 또는 원격 PR 작업을 수행하지 않습니다.

## 데이터와 권한

- Virtual PR 상태와 댓글은 VS Code의 workspace storage에 로컬로 저장됩니다.
- 확장 자체는 별도의 telemetry를 수집하지 않습니다.
- AI 작업을 요청하면 코드 문맥과 리뷰 내용이 로컬 Codex App Server를 통해 사용자의 Codex 환경으로 전달됩니다.
- AI 실행은 열린 workspace를 기준으로 하는 workspace-write sandbox를 사용합니다.
- 기본 approval policy는 `never`이며 `virtualPr.codexApprovalPolicy` 설정으로 변경할 수 있습니다.
- 이 확장은 GitHub PR을 생성하거나 외부 서비스에 댓글을 게시하지 않습니다.

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `virtualPr.defaultBaseRef` | 빈 값 | Virtual PR 비교 기준 ref. 빈 값이면 자동 탐색합니다. |
| `virtualPr.codexPath` | 빈 값 | Codex 실행 파일 경로. 빈 값이면 설치된 OpenAI extension, ChatGPT 앱, PATH 순으로 탐색합니다. |
| `virtualPr.codexApprovalPolicy` | `never` | `never`, `on-request`, `untrusted` 중 선택합니다. |

## 소스에서 빌드

```sh
npm ci
npm test
npm run check
npx vsce package --no-dependencies
```

생성된 VSIX는 다음 명령으로 설치할 수 있습니다.

```sh
code --install-extension ./local-virtual-pr-0.5.0.vsix --force
```

## 제한사항

- 현재 첫 번째 VS Code workspace folder만 사용합니다.
- 리뷰 댓글은 기준 ref 대비 변경된 파일과 줄에만 추가할 수 있습니다.
- OpenAI Codex extension의 공개 extension interface가 아니라 Codex App Server 프로토콜을 사용합니다.
- OpenAI 또는 Microsoft의 공식 제품이 아니며 두 회사의 보증이나 지원을 받지 않습니다.

## 라이선스

[MIT](LICENSE)
