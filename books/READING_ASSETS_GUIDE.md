# 📚 Reading Assets Guide

SkoolClass 리딩 프로그램에서 사용하는 오디오/이미지 파일 관리 가이드.

---

## 📁 폴더 구조

```
books/
  [book-id]/
    vocab/
      word1.mp3
      word2.mp3
    sentences/
      page01.mp3
      page02.mp3
    speaking/
      q01.mp3
      q02.mp3
    images/
      vocab/
        word1.jpg
        word2.jpg
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

## 🎙️ vocab/ — 단어 발음 오디오

Warm Up 단계에서 단어 탭 시 재생.

| 파일명 규칙 | 예시 |
|---|---|
| 단어 그대로 소문자 | `cat.mp3` |
| 공백은 언더스코어 | `big_house.mp3` |
| phrase도 동일 | `look_out.mp3` |

**ElevenLabs 권장 설정:**
- Voice: 책 설정에서 지정한 캐릭터 보이스
- Speed: 0.85 (아이들용 약간 천천히)
- Format: MP3, 22kHz

---

## 🔊 sentences/ — 페이지별 문장 오디오

Listen Up 단계에서 페이지 탭 시 재생.

| 파일명 규칙 | 예시 |
|---|---|
| page + 2자리 번호 | `page01.mp3` |
| | `page02.mp3` |

페이지 번호는 FlipHTML5 책 페이지 번호와 일치시킬 것.

---

## 🗣️ speaking/ — AI 질문 오디오

Speak Up 단계에서 캐릭터가 질문하는 오디오 (높은 레벨).

| 파일명 규칙 | 예시 |
|---|---|
| q + 2자리 번호 | `q01.mp3` |
| | `q02.mp3` |

**ElevenLabs 권장 설정:**
- Voice: 책 캐릭터 전용 보이스
- 질문 끝 억양 유지 (자연스러운 질문 톤)

---

## 🖼️ images/vocab/ — 단어 이미지

Warm Up 카드에 표시되는 단어 예시 이미지.

| 규칙 | 내용 |
|---|---|
| 파일명 | 단어와 동일 (`cat.jpg`) |
| 크기 | 600×400px 권장 |
| 포맷 | JPG 또는 WebP |
| 용량 | 100KB 이하 |

---

## 🌐 CDN URL 패턴

파일 업로드 후 아래 URL로 바로 사용 가능:

```
https://cdn.jsdelivr.net/gh/RosemontAcademy/SkoolClassAssets@main/books/[book-id]/[경로]
```

**예시:**
```
vocab 오디오:   .../books/ort-bck-1/vocab/cat.mp3
문장 오디오:    .../books/ort-bck-1/sentences/page01.mp3
캐릭터 질문:   .../books/ort-bck-1/speaking/q01.mp3
단어 이미지:   .../books/ort-bck-1/images/vocab/cat.jpg
```

> ⚠️ 처음 올리면 CDN 반영까지 최대 10분 소요.
> 빠른 확인은 `@main` 대신 `@[커밋해시]` 사용.

---

## ✅ 업로드 체크리스트

책 하나 추가할 때 확인:

- [ ] book-id가 SkoolClass 설정과 일치하는가
- [ ] 파일명 소문자, 공백 없는가
- [ ] vocab 오디오 개수가 설정한 단어 수와 맞는가 (4/6/8/10/12)
- [ ] sentences 오디오가 페이지 수와 맞는가
- [ ] 이미지 100KB 이하인가
- [ ] GitHub commit 후 CDN URL로 재생 테스트했는가

---

## 📂 예시 완성 구조

```
books/
  ort-bck-1/
    vocab/
      cat.mp3
      dog.mp3
      odd.mp3
      duck.mp3
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
        cat.jpg
        dog.jpg
        odd.jpg
        duck.jpg
      cover.jpg
```
