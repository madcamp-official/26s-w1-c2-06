export interface User {
  id: number;
  username: string;
}

export type RoomStatus = 'waiting' | 'playing' | 'finished';

export interface Room {
  code: string;
  status: RoomStatus;
  player1: string | null;
  player2: string | null;
  is_host: boolean;
}
