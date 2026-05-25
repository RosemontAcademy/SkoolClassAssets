# 📚 Reading Assets Guide

SkoolClass 리딩 프로그램에서 사용하는 오디오/이미지 파일 관리 가이드.

---

## 📁 폴더 구조

```
books/
  [book-id]/
    vocab/
      odd.mp3          ← 단어 발음 (단어 탭 시)
      odd_1.mp3        ← 이미지1 탭 오디오
      odd_2.mp3        ← 이미지2 탭 오디오 (예문이면 문장 전체 읽기)
      odd_3.mp3        ← 이미지3 탭 오디오
    sentences/
      page01.mp3
      page02.mp3
    speaking/
      q01.mp3
      q02.mp3
    images/
      vocab/
        odd_1.jpg
        odd_2.jpg
        odd_3.jpg
      cover.jpg
```

---

## 🔑 book-id 규칙

책 설정(SkoolClass 관리자)에서 지정하는 ID와 **정확히 일치**해야 함.

| 예시 책 | book-id |
|---|---|
| ORT Book Club Kipper 1 | `ort-bck-1` |
| ORT Book Club Kipper 2 | `ort-bck-2` |
| Biff and Chip 3 | `ort-bc-3` |

규칙: **소문자 + 하이픈만** 사용. 공백/특수문자 금지.

---

## 🎙️ vocab/ — 단어 & 이미지 오디오

Warm Up 단계에서 사용.

### 파일 종류

| 파일명 | 설명 | 예시 |
|---|---|---|
| `[단어].mp3` | 상단 단어 탭 시 발음 재생 | `odd.mp3` |
| `[단어]_1.mp3` | 이미지 1번 탭 시 재생 | `odd_1.mp3` |
| `[단어]_2.mp3` | 이미지 2번 탭 시 재생 | `odd_2.mp3` |
| `[단어]_3.mp3` | 이미지 3번 탭 시 재생 | `odd_3.mp3` |

- 예문이 있는 이미지의 오디오(`odd_2.mp3`)는 **문장 전체를 읽는 오디오**로 제작
- 예문 없는 이미지의 오디오는 단어 발음만 재생해도 OK

### phrase (두 단어 이상) 파일명

공백은 언더스코어로 대체:

| 단어/phrase | 파일명 |
|---|---|
| `look out` | `look_out.mp3`, `look_out_1.mp3` ... |
| `big house` | `big_house.mp3`, `big_house_1.mp3` ... |

### ElevenLabs 권장 설정
- Voice: 책 설정에서 지정한 캐릭터 보이스
- Speed: 0.85 (아이들용)
- Format: MP3, 22kHz

---

## 🖼️ images/vocab/ — 단어 이미지 (3장/단어)

Warm Up 카드 캐러셀에 표시. 단어당 이미지 **정확히 3장**.

| 규칙 | 내용 |
|---|---|
| 파일명 | `[단어]_1.jpg`, `[단어]_2.jpg`, `[단어]_3.jpg` |
| 크기 | 600×450px 권장 (4:3 비율) |
| 포맷 | JPG 또는 WebP |
| 용량 | 100KB 이하 |

### 예문 이미지 지정 규칙

3장 중 **1장에만** 예문 표시. 어떤 장에 예문을 붙일지는 DB 설정에서 지정 (아래 참고).

---

## 📋 DB vocab 설정 형식

책 설정(SkoolClass 관리자)에서 단어별로 저장하는 JSON 구조:

```json
[
  {
    "word": "odd",
    "audio": "odd.mp3",
    "images": [
      { "file": "odd_1.jpg", "audio": "odd_1.mp3" },
      { "file": "odd_2.jpg", "audio": "odd_2.mp3",
        "sentence": "The cactus looks very odd.", "highlight": "odd" },
      { "file": "odd_3.jpg", "audio": "odd_3.mp3" }
    ]
  },
  {
    "word": "farm",
    "audio": "farm.mp3",
    "images": [
      { "file": "farm_1.jpg", "audio": "farm_1.mp3",
        "sentence": "Animals live on a farm.", "highlight": "farm" },
      { "file": "farm_2.jpg", "audio": "farm_2.mp3" },
      { "file": "farm_3.jpg", "audio": "farm_3.mp3" }
    ]
  }
]
```

| 필드 | 설명 |
|---|---|
| `word` | 단어 (상단 표시 + 파일명 기준) |
| `audio` | 단어 발음 오디오 파일명 |
| `images[].file` | 이미지 파일명 |
| `images[].audio` | 이미지 탭 시 재생 오디오 |
| `images[].sentence` | (선택) 예문 — 이미지 하단에 표시 |
| `images[].highlight` | (선택) 예문 중 오렌지로 강조할 단어/phrase |

---

## 🔊 sentences/ — 페이지별 문장 오디오

Listen Up 단계에서 페이지 탭 시 재생.

| 파일명 규칙 | 예시 |
|---|---|
| `page` + 2자리 번호 | `page01.mp3`, `page02.mp3` |

페이지 번호는 FlipHTML5 책 페이지 번호와 일치시킬 것.

---

## 🗣️ speaking/ — AI 캐릭터 질문 오디오

Speak Up 단계 (높은 레벨) — 캐릭터가 질문하는 오디오.

| 파일명 규칙 | 예시 |
|---|---|
| `q` + 2자리 번호 | `q01.mp3`, `q02.mp3` |

ElevenLabs 캐릭터 보이스 사용. 질문 끝 억양 유지.

---

## 🌐 CDN URL 패턴

```
https://cdn.jsdelivr.net/gh/RosemontAcademy/SkoolClassAssets@main/books/[book-id]/[경로]
```

**예시:**
```
단어 발음:     .../books/ort-bck-1/vocab/odd.mp3
이미지 오디오: .../books/ort-bck-1/vocab/odd_2.mp3
단어 이미지:   .../books/ort-bck-1/images/vocab/odd_1.jpg
문장 오디오:   .../books/ort-bck-1/sentences/page01.mp3
```

> ⚠️ 처음 올리면 CDN 반영까지 최대 10분 소요.

---

## ✅ 책 1권 업로드 체크리스트

- [ ] book-id가 SkoolClass 설정과 일치
- [ ] 단어당 이미지 정확히 3장 (`_1`, `_2`, `_3`)
- [ ] 단어당 오디오 4개 (단어 발음 + 이미지별 3개)
- [ ] 예문 지정 이미지 오디오는 문장 전체 읽기로 제작
- [ ] 파일명 소문자, 공백 없음
- [ ] 이미지 100KB 이하
- [ ] DB 설정에 `sentence` + `highlight` 필드 입력
- [ ] CDN URL 재생 테스트 완료

---

## 📂 예시 완성 구조 (ort-bck-1, 단어 4개)

```
books/
  ort-bck-1/
    vocab/
      odd.mp3
      odd_1.mp3
      odd_2.mp3
      odd_3.mp3
      farm.mp3
      farm_1.mp3
      farm_2.mp3
      farm_3.mp3
      egg.mp3
      egg_1.mp3
      egg_2.mp3
      egg_3.mp3
      turn.mp3
      turn_1.mp3
      turn_2.mp3
      turn_3.mp3
    sentences/
      page01.mp3
      page02.mp3
      page03.mp3
      page04.mp3
      page05.mp3
      page06.mp3
    speaking/
      q01.mp3
      q02.mp3
      q03.mp3
    images/
      vocab/
        odd_1.jpg
        odd_2.jpg
        odd_3.jpg
        farm_1.jpg
        farm_2.jpg
        farm_3.jpg
        egg_1.jpg
        egg_2.jpg
        egg_3.jpg
        turn_1.jpg
        turn_2.jpg
        turn_3.jpg
      cover.jpg
```
