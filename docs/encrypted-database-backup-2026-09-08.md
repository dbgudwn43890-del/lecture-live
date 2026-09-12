# Lecue 암호화 DB 백업과 복구

이 작업은 **DB 백업**이다. 사용자 계정의 식별자·비밀번호 해시, 강의·노트·추출한 자료 본문, 결제 잔액과 지급 기록을 복구할 수 있도록 한다. PDF 원본 파일과 외부 서비스 설정까지 포함하는 전체 서비스 백업이라고 표현하지 않는다.

## 실행 구성

- `.github/workflows/database-backup.yml`: 매일 UTC 18:17(KST 03:17), 수동 실행 지원. 비공개 저장소에서만 실행한다.
- `scripts/backup/create.py`: 같은 PostgreSQL snapshot에서 migration 버전·행 수·custom-format dump를 생성하고 age로 암호화한다.
- GitHub artifact에는 `.age` 파일만 올리며 14일 보관한다. 평문 덤프·manifest는 권한 0700의 임시 디렉터리에만 만들고 종료 시 지운다.
- 백업은 전용 `lecue_backup` 로그인만 사용한다. 애플리케이션 서비스 키나 관리자 DB 계정은 CI에 저장하지 않는다.
- 연결 정보는 환경변수로만 읽고 DB 비밀번호를 명령 인수·로그에 넣지 않는다. 원격 DB는 TLS 필수다.
- 복구용 개인키는 GitHub에 저장하지 않는다. 자동 작업은 공개 recipient만 가진다.
- 공개 테이블은 검토한 allowlist만 포함한다. 새 테이블이 생기면 조용히 빼거나 비밀 내용을 포함하는 대신 작업을 실패시켜 검토하게 한다.
- 작업 시간은 20분, 결과 크기는 256 MiB로 제한한다. 한도를 넘으면 성공으로 표시하지 않으며 운영자가 상향 또는 백업 저장소 변경을 검토해야 한다.

## 운영자가 설정할 것

GitHub Actions secrets:

| 이름 | 내용 |
|---|---|
| `BACKUP_DATABASE_URL` | Supabase PostgreSQL 연결. Session pooler 또는 직접 연결 사용. Transaction pooler 사용 금지. `sslmode=require` 이상. |
| `BACKUP_AGE_RECIPIENT` | `age-keygen`이 만든 `age1...` 공개 수신자 키. |

`age-keygen -o /안전한/경로/lecue-backup.agekey`로 개인키 파일을 만든 뒤, `age-keygen -y /안전한/경로/lecue-backup.agekey`로 공개 recipient를 얻는다. 개인키는 사용자 비밀번호 관리자 등 별도 안전한 보관소에 보관한다. 유실하면 백업을 복호화할 수 없다. DB 연결값과 개인키를 채팅·Git·Actions 로그에 넣지 않는다.

등록 후 수동 workflow를 한 번 실행하고 암호화 artifact를 내려받아 복구 시험을 수행해야 운영 백업 활성화가 끝난다. 코드나 합성 데이터 시험만 통과한 상태를 운영 백업 완료로 기록하지 않는다.

## 백업 역할의 최소 권한

`python3 scripts/backup/provision-role.py`는 비밀번호 없는 SQL만 출력하며 DB에 연결하지 않는다. 스키마 소유자가 SQL을 적용한 뒤, 별도로 생성한 비밀번호의 SCRAM verifier를 설정하고 마지막에 `ALTER ROLE lecue_backup LOGIN`으로 활성화한다. 실행 전까지 역할은 NOLOGIN이다.

- NOINHERIT·NOBYPASSRLS·NOSUPERUSER·NOCREATEDB·NOCREATEROLE·NOREPLICATION, 최대 연결 2개.
- `public` 사업 데이터 allowlist, `auth.users`·`auth.identities`, `supabase_migrations.schema_migrations`에만 SELECT. 포함 테이블 소유 시퀀스는 SELECT만 허용한다.
- 기존 RLS를 켜거나 끄지 않는다. 이미 RLS가 켜진 포함 테이블에 백업 역할 전용 SELECT 정책만 추가한다. 애플리케이션 역할·기존 정책은 바꾸지 않는다.
- 사용자 API 키·로그인 세션·중계 티켓 등 제외 테이블의 SELECT는 부여하지 않는다. 쓰기나 다른 역할 전환 권한도 부여하지 않는다.
- PUBLIC으로 실행 가능한 SECURITY DEFINER 함수가 있으면 프로비저닝을 중단해 검토한다. NOINHERIT만으로 PUBLIC 함수의 실행 권한은 없어지지 않기 때문이다.
- 제외 테이블·컬럼에 남은 SELECT, PUBLIC으로 상속된 쓰기·시퀀스 변경 권한, 백업 역할의 소유권과 역할 멤버십도 거부한다. PostgreSQL16+에서 생성자에게 자동 부여되는 ADMIN/NOINHERIT/NOSET 멤버십만 현재 운영자에 한해 허용한다. 임시 테이블에 부착할 수 있는 SECURITY DEFINER trigger 함수도 검사한다.
- `pg_dump`에는 `--enable-row-security`를 사용한다. `--exclude-table-data`도 제외 테이블에 SELECT 잠금을 요구하므로 `--exclude-table`로 정의까지 제외한다. 제외 테이블 정의는 일치하는 Supabase 스키마와 기록된 애플리케이션 migration으로 복구한다.

## 포함·제외 범위

포함:

- `public`의 검토된 사업 데이터 테이블과 스키마.
- `auth.users`, `auth.identities` 데이터. 비밀번호는 DB에 저장된 해시이며 평문 비밀번호를 새로 수집하지 않는다.
- `supabase_migrations`와 덤프 snapshot 기준 migration 목록·테이블 행 수·덤프 SHA-256.

제외:

- `vault` 스키마와 `public.user_llm_credentials` 데이터. 복구 후 개인 API 키는 다시 등록한다.
- `auth`의 활성 세션·토큰·MFA 등 `users`/`identities` 외 테이블 데이터. 복구 후 다시 로그인하고 필요한 인증 설정을 재등록한다.
- 재사용할 필요 없는 rate limit, generation lease, STT 임시 ticket/session 데이터.
- Storage 원본 파일. PDF에서 추출한 본문·벡터는 DB에 포함되지만 PDF 파일 자체는 복구되지 않는다. 업로드 음성은 짧게 보관한 뒤 지우는 정책이라 의도적으로 백업하지 않는다.
- Supabase Auth 설정, OAuth/SMTP/API 키, Paddle/Deepgram/OpenAI/Cloudflare/Vercel 설정.

## 복구 절차

1. 운영 DB에 덮어쓰지 말고 별도 프로젝트나 격리 DB에 먼저 복구한다. 대상 PostgreSQL/Supabase 버전과 pgvector 등 확장, `auth`/`public` 시스템 역할·스키마를 준비한다. 제외 테이블은 manifest의 `excludedTableSchemas`를 확인하고 일치하는 Supabase 스키마·애플리케이션 migration으로 준비한다. 정책에 참조된 `lecue_backup` 역할도 NOLOGIN으로 준비한다.
2. `age --decrypt -i /안전한/경로/lecue-backup.agekey -o snapshot.tar backup.tar.age`로 복호화한다. 성공해야 다음으로 진행한다.
3. tar에는 `database.dump`, `manifest.json` 두 파일만 있어야 한다. 덤프의 SHA-256을 manifest와 대조한다.
4. `pg_restore --list database.dump`로 대상 목록을 확인한다. 빈 PostgreSQL에 스키마까지 복구하는 시험과, Supabase 기본 스키마가 준비된 대상에 데이터만 넣는 복구는 절차가 다르다. 후자는 manifest와 같은 migration까지 준비한 뒤 충돌하는 기존 seed/사용자 데이터가 없는지 확인하고 `pg_restore --data-only --no-owner --no-acl`을 사용한다. 관리형 DB에서 trigger 무효화 권한을 가정하지 않는다.
5. 모든 포함 테이블의 행 수를 manifest와 대조하고 사용자→강의→노트 관계, 실제 샘플 노트/질문, 크레딧 잔액과 지급/환불 기록을 확인한다. 애플리케이션을 붙여 로그인·강의 열람·잔액 계산까지 시험한다.
6. 새 환경의 API/OAuth/SMTP/Paddle webhook 설정과 MFA를 복구하고, 기존 미완료 처리·임시 Storage 삭제 job을 점검한 뒤 공개 전환한다. PDF 원본을 따로 복구하지 않았다면 기존 `storage_path`를 그대로 정상 원본으로 표시하지 않도록 처리해야 한다.

덤프는 `--no-owner --no-acl`을 사용한다. 따라서 빈 DB에 스키마를 복원한 것만으로 운영 권한이 복구된 것은 아니다. 새 함수에 PostgreSQL 기본 PUBLIC EXECUTE가 생길 수 있으므로 **일치하는 migration/권한을 준비한 DB에 데이터만 복원**하는 방식을 우선한다. 전체 스키마 복원으로 시험했다면 함수·테이블·컬럼·RLS 권한 검사까지 마친 뒤에만 앱을 연결한다.

## 검증 기록

`PG_BIN=/opt/homebrew/opt/postgresql@18/bin AGE_BIN=/path/to/age AGE_KEYGEN_BIN=/path/to/age-keygen python3 scripts/backup/test-restore.py`는 운영 연결값을 읽지 않고 임시 PostgreSQL과 합성 사용자로 다음을 검증한다.

- 실제 최소 권한 로그인으로 실행하고 RLS가 켜진 포함 데이터가 빠지지 않는지 확인한다. 제외 API 키·로그인 토큰 접근과 쓰기 권한도 거부되는지 확인한다.
- snapshot → age 암호화 → 복호화 → 실제 `pg_restore` 전체 왕복.
- 사용자 식별자·비밀번호 해시·identity 관계, 강의 본문, 노트, 정확한 크레딧 잔액 및 migration 복원.
- 복원된 외래키가 잘못된 사용자를 참조하는 새 행을 계속 거부함.
- Vault/API 키/활성 로그인 세션 데이터 제외, 암호문 수정 시 복호화 거부.

이는 재현 가능한 합성 데이터 복구 검증이다. 운영 Supabase 전체 확장·스키마의 실제 복구 시험과 PDF 원본 복제는 별도로 완료 상태를 기록해야 한다.

공식 자료: [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html), [age](https://github.com/FiloSottile/age), [GitHub artifact 보관](https://docs.github.com/en/actions/tutorials/store-and-share-data).
