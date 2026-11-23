---
name: drawing-record
description: Writes a one-page record of how the user checked a drawing with Claude - in Traditional Chinese, what was checked, the drawing conventions as rules with examples, how the user asked and what they corrected, saved only after they approve it. Use when the user says 「幫我記錄這次」, 「記錄一下」, 「記錄這次」, 「做個紀錄」 or "record this".
---

Record how the user just checked a drawing with Claude, so that their own conventions and habits can later become a drawing-check helper. The records are read together after about 20 of them, so each one is short, concrete and true to what happened.

Do nothing until the user asks for a record. While they work, help as usual: this skill must not change how you answer.

**1. Gather, from this conversation only**, since the last record in it (or from the start):
- the drawings and parts checked, by part name and number as they appeared;
- every convention the user applied or stated (title block, views, dimensions, tolerances, notes, labels, balloons, parts list, units, line types or anything else), each as a rule they would apply to the next drawing;
- how they asked: what they gave you (a screenshot, a PDF, a file), the words they used, in what order, and what they expected back;
- every correction: where the user changed or overruled your answer, what they said, and the right answer. A hedge of yours they simply confirmed is a convention, not a correction.

Use only what happened. Never invent a convention, and never assume a company or drafting standard; if the user named one, write it as they said it. Word each rule only as widely as the user's own words or reason support. Mark anything they did not say themselves, whether you inferred it or it was your wording they did not confirm, with 「（推測，請確認）」.

**2. Draft the record** in 繁體中文, one page at most (about 40 lines), in this shape:

```markdown
# <主題> · YYYY-MM-DD

## 這次檢查了什麼
- <零件名稱／編號>：<檢查了哪些地方>

## 圖面慣例
1. 規則：<一條可以拿來檢查下一張圖的規則>
   例：<這次的例子，含零件名稱、編號或尺寸>

## 怎麼問的
- 給了什麼：<截圖／PDF／…>
- 順序：<先給什麼、再說什麼>
- 用語：「<關鍵用語，簡短引用>」
- 想得到：<一份清單／標出錯誤／…>

## 修正
- Claude 一開始：<…> → 修正：「<簡短引用>」 → 正確是：<…>
```

A section with nothing in it says 「無」. `<主題>` names what was checked in a few words, with the part number when there is one, such as 「BRK-102軸承座側視圖」: no spaces and none of `\ / : * ? " < > |`, since it is also the file name.

Part names and numbers stay in. Leave out:
- images and drawing files;
- customer and company names (write 「[客戶]」);
- people's names;
- the conversation itself, except short quotes of the user's own words.

**3. Show the draft and wait.** Show the draft, then end with: 「以上是這次的紀錄草稿。要改哪裡請直接說；沒問題請回「好」，我才會存檔。」 Apply their changes and show it again. Save only after 「好」 or another clear yes (「可以」, 「存吧」, "ok"). If they say no or move on to something else, save nothing.

**4. Save** it as `紀錄/YYYY-MM-DD-<主題>.md` in the folder this session works in (the user keeps one folder for drawing checks), creating `紀錄` if it is missing; if the name is taken, add `-2`, `-3`. Write only this one file: never change, move or delete a drawing or any other file. Then say where it is and how many records the folder now holds: 「已存成 紀錄/<檔名>，這是第 N 份紀錄。」

If nothing in this conversation was a drawing check, say so and save nothing.

Keep it simple but useful: the shortest version that still does the job, nothing extra.
