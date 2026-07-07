import type { LeaderboardEntry, WorstEntry } from '../types';
import './Leaderboard.css';

interface LeaderboardProps {
  entries: LeaderboardEntry[];
  me: LeaderboardEntry | null;
  myUsername: string | null;
  worst?: WorstEntry[];
}

const WORST_LABELS = ['꼴찌', '뒤에서 2등', '뒤에서 3등'];

function Leaderboard({ entries, me, myUsername, worst = [] }: LeaderboardProps) {
  if (entries.length === 0 && !me && worst.length === 0) return null;

  return (
    <div className="leaderboard">
      {(entries.length > 0 || me) && (
        <>
          <h3>전체 랭킹</h3>
          {entries.length > 0 && (
            <ol className="leaderboard-list">
              {entries.map((entry) => (
                <li key={entry.username} className={entry.username === myUsername ? 'leaderboard-me' : ''}>
                  <span className="leaderboard-rank">{entry.rank}</span>
                  <span className="leaderboard-username">{entry.username}</span>
                  <span className="leaderboard-score">{entry.total_score}</span>
                </li>
              ))}
            </ol>
          )}
          {me && (
            <ol className="leaderboard-list leaderboard-list-me">
              <li className="leaderboard-me">
                <span className="leaderboard-rank">{me.rank}</span>
                <span className="leaderboard-username">{me.username}</span>
                <span className="leaderboard-score">{me.total_score}</span>
              </li>
            </ol>
          )}
        </>
      )}

      {worst.length > 0 && (
        <div className="leaderboard-worst">
          <h3>🐌 하위권 명예의 전당</h3>
          <ol className="leaderboard-list worst-list">
            {worst.map((entry, i) => (
              <li
                key={entry.username}
                className={`worst-entry ${entry.username === myUsername ? 'leaderboard-me' : ''}`}
              >
                <span className="worst-rank">{WORST_LABELS[i] ?? `-${i + 1}`}</span>
                <span className="leaderboard-username">{entry.username}</span>
                <span className="leaderboard-score">{entry.total_score}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export default Leaderboard;
