import { Question, Room, Attempt } from '../models/exam.js';
import { Institution } from '../models/core.js';

/* ============================================================
   WHAT STANDS BETWEEN A PAPER AND ITS CANDIDATES

   Lifted out of the examinations router so the bulk scheduler runs
   exactly the same checks. Two implementations of "is this paper fit
   to publish" would diverge, and the divergence would show up as a
   paper published in bulk that the single publish would have
   refused — which is the worst possible direction for it to fail in.
   ============================================================ */
export async function collectConflicts(exam, institutionId) {
  const out = [];
  const rooms = await Room.find({ examId: exam._id }).populate('invigilatorId', 'name').lean();

  if (!rooms.length) {
    out.push({ kind: 'no_rooms', blocking: true, message: 'No rooms have been created for this examination' });
  }

  // 1. rooms without an invigilator
  for (const room of rooms) {
    if (!room.invigilatorId) {
      out.push({ kind: 'invigilator_missing', blocking: true, roomId: String(room._id),
        message: `${room.name} has no invigilator assigned` });
    }
    if (room.studentIds.length > room.capacity) {
      out.push({ kind: 'over_capacity', blocking: true, roomId: String(room._id),
        message: `${room.name} holds ${room.studentIds.length} candidates but its capacity is ${room.capacity}` });
    }
  }

  // 2. one invigilator in two overlapping rooms
  const seen = new Map();
  for (const room of rooms) {
    if (!room.invigilatorId) continue;
    const key = String(room.invigilatorId._id);
    const prior = seen.get(key) || [];
    for (const other of prior) {
      if (room.startAt < other.endAt && room.endAt > other.startAt) {
        out.push({ kind: 'invigilator_clash', blocking: true,
          message: `${room.invigilatorId.name} is assigned to both ${other.name} and ${room.name} at the same time` });
      }
    }
    seen.set(key, [...prior, room]);
  }

  // 3. invigilator already booked on another examination
  for (const room of rooms) {
    if (!room.invigilatorId) continue;

    /* A room's window is the ordinary one. If candidates in it have
       been given sittings of their own, the invigilator is needed
       until the last of those ends — and a clash check that stopped
       at the room's own endAt would happily double-book them for the
       afternoon. */
    const sittings = await Attempt.find({
      roomId: room._id, 'sitting.startsAt': { $ne: null },
    }).select('sitting').lean();

    let watchUntil = new Date(room.endAt);
    for (const a of sittings) {
      const ends = new Date(new Date(a.sitting.startsAt).getTime()
        + (a.sitting.durationMinutes || exam.durationMinutes) * 60000);
      if (ends > watchUntil) watchUntil = ends;
    }

    const clash = await Room.findOne({
      institutionId,
      examId: { $ne: exam._id },
      invigilatorId: room.invigilatorId._id,
      startAt: { $lt: watchUntil },
      endAt: { $gt: room.startAt },
    }).populate('examId', 'title').lean();
    if (clash) {
      out.push({ kind: 'invigilator_clash_other_exam', blocking: true,
        message: `${room.invigilatorId.name} is already invigilating ${clash.examId?.title || 'another examination'} at this time` });
    }
  }

  // 4. a candidate scheduled into two rooms at once
  const allStudentIds = rooms.flatMap((x) => x.studentIds.map(String));
  const dupes = allStudentIds.filter((id, i) => allStudentIds.indexOf(id) !== i);
  if (dupes.length) {
    out.push({ kind: 'student_duplicate', blocking: true,
      message: `${new Set(dupes).size} candidate(s) are allocated to more than one room` });
  }

  const overlapping = await Room.find({
    institutionId,
    examId: { $ne: exam._id },
    studentIds: { $in: allStudentIds },
    startAt: { $lt: rooms[0]?.endAt },
    endAt: { $gt: rooms[0]?.startAt },
  }).populate('examId', 'title').lean();
  for (const o of overlapping) {
    out.push({ kind: 'student_clash_other_exam', blocking: true,
      message: `Some candidates are also scheduled for ${o.examId?.title || 'another examination'} at this time` });
  }

  // 5. blueprint not fully authored
  const counts = await Question.aggregate([
    { $match: { examId: exam._id } },
    { $group: { _id: '$section', n: { $sum: 1 } } },
  ]);
  const have = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  for (const s of exam.blueprint.sections) {
    const got = have[s.key] || 0;
    if (got < s.count) {
      out.push({ kind: 'questions_missing', blocking: true,
        message: `Part ${s.key} has ${got} of ${s.count} questions authored` });
    }
  }

  // 6. licence balance
  const institution = await Institution.findById(institutionId).lean();
  const needed = allStudentIds.length;
  const available = (institution?.licence?.balance || 0) - (institution?.licence?.reserved || 0);
  if (needed > available) {
    out.push({ kind: 'licence_short', blocking: true,
      message: `${needed} licences are needed but only ${available} remain. Publication is blocked so that no examination can fail on the day for want of licences.` });
  }

  return out;
}
