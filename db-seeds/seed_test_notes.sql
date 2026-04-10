-- Test notes for Xing#1673 (user_id=1, blizzard_char_id=127678522)
-- Local development only. Do not run in production.
-- Run locally: npm run db:seed:test-notes
INSERT INTO raider_notes (blizzard_char_id, author_user_id, note_text, created_at) VALUES
  (127678522, 1, 'Consistent performer, always shows up prepared with consumables.', strftime('%s','now','-60 days')),
  (127678522, 1, 'Missed raid night without notice. Worth checking in.', strftime('%s','now','-55 days')),
  (127678522, 1, 'Great attitude during progression wipes, keeps the group motivated.', strftime('%s','now','-50 days')),
  (127678522, 1, 'Spoke to them about rotation - they are going to review the current sim data.', strftime('%s','now','-45 days')),
  (127678522, 1, 'Top DPS on Mythic Silken Court this week. Solid.', strftime('%s','now','-40 days')),
  (127678522, 1, 'Asked about potentially swapping to an alt for prog. Will discuss further.', strftime('%s','now','-35 days')),
  (127678522, 1, 'Performance has noticeably improved over the last few weeks.', strftime('%s','now','-30 days')),
  (127678522, 1, 'Flagged an issue with loot distribution - handled offline.', strftime('%s','now','-25 days')),
  (127678522, 1, 'Applied to trial as a Raider. Interview done, positive impression.', strftime('%s','now','-20 days')),
  (127678522, 1, 'Promoted to full Raider rank after trial period.', strftime('%s','now','-18 days')),
  (127678522, 1, 'Loot council discussion: prioritising tier pieces this tier.', strftime('%s','now','-15 days')),
  (127678522, 1, 'Reminded to update WeakAuras before next reset.', strftime('%s','now','-12 days')),
  (127678522, 1, 'Brought up concerns about raid schedule - noted for officer discussion.', strftime('%s','now','-10 days')),
  (127678522, 1, 'Two-week absence coming up - confirmed and noted on the schedule.', strftime('%s','now','-8 days')),
  (127678522, 1, 'Back from absence, immediately re-integrated with no issues.', strftime('%s','now','-6 days')),
  (127678522, 1, 'Had a great run in M+ this week, 16 key depleted but close.', strftime('%s','now','-5 days')),
  (127678522, 1, 'Volunteered to sit for the final boss attempt to bring in an extra healer. Good sportsmanship.', strftime('%s','now','-3 days')),
  (127678522, 1, 'Officer chat: potential candidate for raid leader backup role.', strftime('%s','now','-2 days')),
  (127678522, 1, 'Updated gear checklist ahead of next tier release.', strftime('%s','now','-1 day')),
  (127678522, 1, 'Confirmed attendance for the next 4 weeks of prog.', strftime('%s','now'));
