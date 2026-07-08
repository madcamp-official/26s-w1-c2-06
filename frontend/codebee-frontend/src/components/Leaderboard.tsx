import type { LeaderboardEntry, WorstEntry } from '../types';
import TierBadge from './TierBadge';
import './Leaderboard.css';

interface LeaderboardProps {
  entries: LeaderboardEntry[];
  me: LeaderboardEntry | null;
  myUsername: string | null;
  worst?: WorstEntry[];
}

// 1/2/3등 랭크 위에 얹는 왕관·메달 장식.
const RANK_MEDALS: Record<number, string> = { 1: '👑', 2: '🥈', 3: '🥉' };

// 하위권 라벨 — 고정 배열 인덱스 대신 서버가 내려주는 rank(공동순위, 동점자는
// 같은 값)로 생성한다. 동점 그룹 크기가 가변적이라 인덱스 기반으로는 안 맞는다.
function worstLabel(rank: number): string {
  return rank === 1 ? '꼴찌' : `뒤에서 ${rank}등`;
}

function Leaderboard({ entries, me, myUsername, worst = [] }: LeaderboardProps) {
  if (entries.length === 0 && !me && worst.length === 0) return null;

  return (
    <div className="leaderboard">
      {(entries.length > 0 || me) && (
        <div className="leaderboard-top">
          <h3>전체 랭킹</h3>
          {entries.length > 0 && (
            <ol className="leaderboard-list">
              {entries.map((entry) => {
                const medal = RANK_MEDALS[entry.rank];
                return (
                  <li
                    key={entry.username}
                    className={`${entry.username === myUsername ? 'leaderboard-me ' : ''}${medal ? `rank-top rank-${entry.rank}` : ''}`.trim()}
                  >
                    <span className="leaderboard-rank">
                      {medal && (
                        <span className="rank-medal" aria-hidden="true">
                          {medal}
                        </span>
                      )}
                      {entry.rank}
                    </span>
                    <span className="leaderboard-username">{entry.username}</span>
                    <TierBadge tier={entry.tier} tierScore={entry.tier_score} compact />
                  </li>
                );
              })}
            </ol>
          )}
          {me && (
            <ol className="leaderboard-list leaderboard-list-me">
              <li className={`leaderboard-me ${RANK_MEDALS[me.rank] ? `rank-top rank-${me.rank}` : ''}`.trim()}>
                <span className="leaderboard-rank">
                  {RANK_MEDALS[me.rank] && (
                    <span className="rank-medal" aria-hidden="true">
                      {RANK_MEDALS[me.rank]}
                    </span>
                  )}
                  {me.rank}
                </span>
                <span className="leaderboard-username">{me.username}</span>
                <TierBadge tier={me.tier} tierScore={me.tier_score} compact />
              </li>
            </ol>
          )}
        </div>
      )}

      {worst.length > 0 && (
        <div className="leaderboard-worst">
          <h3>🐌 하위권 명예의 전당</h3>
          <ol className="leaderboard-list worst-list">
            {worst.map((entry) => (
              <li
                key={entry.username}
                className={`worst-entry ${entry.username === myUsername ? 'leaderboard-me' : ''}`}
              >
                <span className="worst-rank">{worstLabel(entry.rank)}</span>
                <span className="leaderboard-username">{entry.username}</span>
                <TierBadge tier={entry.tier} tierScore={entry.tier_score} compact />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export default Leaderboard;
