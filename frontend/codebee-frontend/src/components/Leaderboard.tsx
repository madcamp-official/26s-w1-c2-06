import type { LeaderboardEntry } from '../types';
import './Leaderboard.css';

interface LeaderboardProps {
  entries: LeaderboardEntry[];
  me: LeaderboardEntry | null;
  myUsername: string | null;
}

function Leaderboard({ entries, me, myUsername }: LeaderboardProps) {
  if (entries.length === 0 && !me) return null;

  return (
    <div className="leaderboard">
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
    </div>
  );
}

export default Leaderboard;
