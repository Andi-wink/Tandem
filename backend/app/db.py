import aiosqlite
import json
import os
from datetime import datetime, timezone
from typing import Optional, Dict
import logging
from contextlib import asynccontextmanager
import sqlite3
try:
    from .schema_validator import SchemaValidator
except ImportError:
    # Handle case when running as script directly
    import sys
    import os
    sys.path.append(os.path.dirname(__file__))
    from schema_validator import SchemaValidator

logger = logging.getLogger(__name__)

# Provider -> fixed, fully literal SQL statements (single source of truth for API key SQL).
#
# B011: column/identifier names are NEVER interpolated from a runtime variable. Each
# statement is a hardcoded string constant with the column name baked in, so there is no
# path by which a provider value can become part of the SQL identifier text. Only the API
# key VALUE (and INSERT defaults) are bound via ? placeholders.
_MODEL_API_KEY_SQL: dict[str, dict[str, str]] = {
    "openai": {
        "select": "SELECT openaiApiKey FROM settings WHERE id = '1'",
        "update": "UPDATE settings SET openaiApiKey = ? WHERE id = '1'",
        "insert": "INSERT INTO settings (id, provider, model, whisperModel, openaiApiKey) VALUES (?, ?, ?, ?, ?)",
        "clear": "UPDATE settings SET openaiApiKey = NULL WHERE id = '1'",
    },
    "claude": {
        "select": "SELECT anthropicApiKey FROM settings WHERE id = '1'",
        "update": "UPDATE settings SET anthropicApiKey = ? WHERE id = '1'",
        "insert": "INSERT INTO settings (id, provider, model, whisperModel, anthropicApiKey) VALUES (?, ?, ?, ?, ?)",
        "clear": "UPDATE settings SET anthropicApiKey = NULL WHERE id = '1'",
    },
    "groq": {
        "select": "SELECT groqApiKey FROM settings WHERE id = '1'",
        "update": "UPDATE settings SET groqApiKey = ? WHERE id = '1'",
        "insert": "INSERT INTO settings (id, provider, model, whisperModel, groqApiKey) VALUES (?, ?, ?, ?, ?)",
        "clear": "UPDATE settings SET groqApiKey = NULL WHERE id = '1'",
    },
    "ollama": {
        "select": "SELECT ollamaApiKey FROM settings WHERE id = '1'",
        "update": "UPDATE settings SET ollamaApiKey = ? WHERE id = '1'",
        "insert": "INSERT INTO settings (id, provider, model, whisperModel, ollamaApiKey) VALUES (?, ?, ?, ?, ?)",
        "clear": "UPDATE settings SET ollamaApiKey = NULL WHERE id = '1'",
    },
}

_TRANSCRIPT_API_KEY_SQL: dict[str, dict[str, str]] = {
    "localWhisper": {
        "select": "SELECT whisperApiKey FROM transcript_settings WHERE id = '1'",
        "update": "UPDATE transcript_settings SET whisperApiKey = ? WHERE id = '1'",
        "insert": "INSERT INTO transcript_settings (id, provider, model, whisperApiKey) VALUES (?, ?, ?, ?)",
    },
    "deepgram": {
        "select": "SELECT deepgramApiKey FROM transcript_settings WHERE id = '1'",
        "update": "UPDATE transcript_settings SET deepgramApiKey = ? WHERE id = '1'",
        "insert": "INSERT INTO transcript_settings (id, provider, model, deepgramApiKey) VALUES (?, ?, ?, ?)",
    },
    "elevenLabs": {
        "select": "SELECT elevenLabsApiKey FROM transcript_settings WHERE id = '1'",
        "update": "UPDATE transcript_settings SET elevenLabsApiKey = ? WHERE id = '1'",
        "insert": "INSERT INTO transcript_settings (id, provider, model, elevenLabsApiKey) VALUES (?, ?, ?, ?)",
    },
    "groq": {
        "select": "SELECT groqApiKey FROM transcript_settings WHERE id = '1'",
        "update": "UPDATE transcript_settings SET groqApiKey = ? WHERE id = '1'",
        "insert": "INSERT INTO transcript_settings (id, provider, model, groqApiKey) VALUES (?, ?, ?, ?)",
    },
    "openai": {
        "select": "SELECT openaiApiKey FROM transcript_settings WHERE id = '1'",
        "update": "UPDATE transcript_settings SET openaiApiKey = ? WHERE id = '1'",
        "insert": "INSERT INTO transcript_settings (id, provider, model, openaiApiKey) VALUES (?, ?, ?, ?)",
    },
}

def _resolve_api_key_sql(provider: str, mapping: dict[str, dict[str, str]]) -> dict[str, str]:
    """Resolve provider name to its fixed API key SQL statements. Raises ValueError if invalid."""
    stmts = mapping.get(provider)
    if stmts is None:
        raise ValueError(f"Invalid provider: {provider}")
    return stmts

class DatabaseManager:
    def __init__(self, db_path: str = None):
        if db_path is None:
            db_path = os.getenv('DATABASE_PATH', 'meeting_minutes.db')
        self.db_path = db_path
        self.schema_validator = SchemaValidator(self.db_path)
        self._init_db()

    def _init_db(self):
        """Initialize the database with legacy approach"""
        try:
            # Run legacy initialization (handles all table creation)
            logger.info("Initializing database tables...")
            self._legacy_init_db()
            
            # Validate schema integrity
            logger.info("Validating schema integrity...")
            self.schema_validator.validate_schema()
            
        except Exception as e:
            logger.error(f"Database initialization failed: {str(e)}")
            raise



    def _legacy_init_db(self):
        """Legacy database initialization (for backward compatibility)"""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            
            # Create meetings table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS meetings (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    folder_path TEXT
                )
            """)

            # Migration: Add folder_path column to existing meetings table
            try:
                cursor.execute("ALTER TABLE meetings ADD COLUMN folder_path TEXT")
                logger.info("Added folder_path column to meetings table")
            except sqlite3.OperationalError:
                pass  # Column already exists
            
            # Create transcripts table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS transcripts (
                    id TEXT PRIMARY KEY,
                    meeting_id TEXT NOT NULL,
                    transcript TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    summary TEXT,
                    action_items TEXT,
                    key_points TEXT,
                    audio_start_time REAL,
                    audio_end_time REAL,
                    duration REAL,
                    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
                )
            """)

            # Add new columns to existing transcripts table (migration for old databases)
            try:
                cursor.execute("ALTER TABLE transcripts ADD COLUMN audio_start_time REAL")
            except sqlite3.OperationalError:
                pass  # Column already exists
            try:
                cursor.execute("ALTER TABLE transcripts ADD COLUMN audio_end_time REAL")
            except sqlite3.OperationalError:
                pass  # Column already exists
            try:
                cursor.execute("ALTER TABLE transcripts ADD COLUMN duration REAL")
            except sqlite3.OperationalError:
                pass  # Column already exists
            
            # Create summary_processes table (keeping existing functionality)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS summary_processes (
                    meeting_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    error TEXT,
                    result TEXT,
                    start_time TEXT,
                    end_time TEXT,
                    chunk_count INTEGER DEFAULT 0,
                    processing_time REAL DEFAULT 0.0,
                    metadata TEXT,
                    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS transcript_chunks (
                    meeting_id TEXT PRIMARY KEY,
                    meeting_name TEXT,
                    transcript_text TEXT NOT NULL,
                    model TEXT NOT NULL,
                    model_name TEXT NOT NULL,
                    chunk_size INTEGER,
                    overlap INTEGER,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
                )
            """)

            # Create settings table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS settings (
                    id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    whisperModel TEXT NOT NULL,
                    groqApiKey TEXT,
                    openaiApiKey TEXT,
                    anthropicApiKey TEXT,
                    ollamaApiKey TEXT
                )
            """)

            # Create transcript_settings table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS transcript_settings (
                    id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    whisperApiKey TEXT,
                    deepgramApiKey TEXT,
                    elevenLabsApiKey TEXT,
                    groqApiKey TEXT,
                    openaiApiKey TEXT
                )
            """)

            # F022: Speaker Diarization tables
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS diarization_processes (
                    meeting_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT 'pending',
                    progress_pct INTEGER DEFAULT 0,
                    num_speakers INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    error TEXT,
                    result TEXT,
                    processing_time REAL DEFAULT 0.0,
                    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS speaker_names (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT NOT NULL,
                    speaker_label TEXT NOT NULL,
                    display_name TEXT,
                    FOREIGN KEY (meeting_id) REFERENCES meetings(id),
                    UNIQUE(meeting_id, speaker_label)
                )
            """)

            # Phase 6 future tables (schema only, not populated yet)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS speaker_profiles (
                    id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    embedding BLOB,
                    sample_count INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS meeting_speakers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    meeting_id TEXT NOT NULL,
                    speaker_label TEXT NOT NULL,
                    speaker_profile_id TEXT,
                    confidence REAL,
                    FOREIGN KEY (meeting_id) REFERENCES meetings(id),
                    FOREIGN KEY (speaker_profile_id) REFERENCES speaker_profiles(id)
                )
            """)

            conn.commit()

    @asynccontextmanager
    async def _get_connection(self):
        """Get a new database connection"""
        conn = await aiosqlite.connect(self.db_path)
        try:
            yield conn
        finally:
            await conn.close()

    async def create_process(self, meeting_id: str) -> str:
        """Create a new process entry or update existing one and return its ID"""
        now = datetime.now(timezone.utc).isoformat()
        
        try:
            async with self._get_connection() as conn:
                # Begin transaction
                await conn.execute("BEGIN TRANSACTION")
                
                try:
                    # B022: atomic upsert keyed on the meeting_id PRIMARY KEY. A single
                    # statement avoids the previous non-atomic read-then-write, where two
                    # concurrent requests for the same meeting_id could both see 0 updated
                    # rows and both INSERT, causing a PRIMARY KEY constraint violation.
                    # The DO UPDATE branch sets exactly the columns the old UPDATE set
                    # (status, updated_at, start_time, error=NULL, result=NULL) and leaves
                    # created_at untouched so an existing row keeps its original timestamp.
                    await conn.execute(
                        """
                        INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, start_time)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(meeting_id) DO UPDATE SET
                            status = excluded.status,
                            updated_at = excluded.updated_at,
                            start_time = excluded.start_time,
                            error = NULL,
                            result = NULL
                        """,
                        (meeting_id, "PENDING", now, now, now)
                    )

                    await conn.commit()
                    logger.info(f"Successfully created/updated process for meeting_id: {meeting_id}")
                    
                except Exception as e:
                    await conn.rollback()
                    logger.error(f"Failed to create process for meeting_id {meeting_id}: {str(e)}", exc_info=True)
                    raise
                    
        except Exception as e:
            logger.error(f"Database connection error in create_process: {str(e)}", exc_info=True)
            raise
        
        return meeting_id

    async def update_process(self, meeting_id: str, status: str, result: Optional[Dict] = None, error: Optional[str] = None, 
                           chunk_count: Optional[int] = None, processing_time: Optional[float] = None, 
                           metadata: Optional[Dict] = None):
        """Update a process status and result"""
        now = datetime.now(timezone.utc).isoformat()
        
        try:
            async with self._get_connection() as conn:
                # Begin transaction
                await conn.execute("BEGIN TRANSACTION")
                
                try:
                    update_fields = ["status = ?", "updated_at = ?"]
                    params = [status, now]
                    
                    if result:
                        # Validate result can be JSON serialized
                        try:
                            result_json = json.dumps(result)
                            update_fields.append("result = ?")
                            params.append(result_json)
                        except (TypeError, ValueError) as e:
                            logger.error(f"Failed to serialize result for meeting_id {meeting_id}: {str(e)}")
                            raise ValueError("Result data cannot be JSON serialized")
                            
                    if error:
                        # Sanitize error message to prevent log injection
                        sanitized_error = str(error).replace('\n', ' ').replace('\r', '')[:1000]
                        update_fields.append("error = ?")
                        params.append(sanitized_error)
                        
                    if chunk_count is not None:
                        update_fields.append("chunk_count = ?")
                        params.append(chunk_count)
                        
                    if processing_time is not None:
                        update_fields.append("processing_time = ?")
                        params.append(processing_time)
                        
                    if metadata:
                        # Validate metadata can be JSON serialized
                        try:
                            metadata_json = json.dumps(metadata)
                            update_fields.append("metadata = ?")
                            params.append(metadata_json)
                        except (TypeError, ValueError) as e:
                            logger.error(f"Failed to serialize metadata for meeting_id {meeting_id}: {str(e)}")
                            # Don't fail the whole operation for metadata serialization issues
                            
                    if status.upper() in ['COMPLETED', 'FAILED']:
                        update_fields.append("end_time = ?")
                        params.append(now)
                        
                    params.append(meeting_id)
                    query = f"UPDATE summary_processes SET {', '.join(update_fields)} WHERE meeting_id = ?"
                    
                    cursor = await conn.execute(query, params)
                    if cursor.rowcount == 0:
                        logger.warning(f"No process found to update for meeting_id: {meeting_id}")
                        
                    await conn.commit()
                    logger.debug(f"Successfully updated process status to {status} for meeting_id: {meeting_id}")
                    
                except Exception as e:
                    await conn.rollback()
                    logger.error(f"Failed to update process for meeting_id {meeting_id}: {str(e)}", exc_info=True)
                    raise
                    
        except Exception as e:
            logger.error(f"Database connection error in update_process: {str(e)}", exc_info=True)
            raise

    async def save_transcript(self, meeting_id: str, transcript_text: str, model: str, model_name: str, 
                            chunk_size: int, overlap: int):
        """Save transcript data"""
        # Input validation
        if not meeting_id or not meeting_id.strip():
            raise ValueError("meeting_id cannot be empty")
        if not transcript_text or not transcript_text.strip():
            raise ValueError("transcript_text cannot be empty")
        if chunk_size <= 0 or overlap < 0:
            raise ValueError("Invalid chunk_size or overlap values")
        if len(transcript_text) > 10_000_000:  # 10MB limit
            raise ValueError("Transcript text too large (>10MB)")
            
        now = datetime.now(timezone.utc).isoformat()
        
        try:
            async with self._get_connection() as conn:
                await conn.execute("BEGIN TRANSACTION")
                
                try:
                    # First try to update existing transcript
                    cursor = await conn.execute("""
                        UPDATE transcript_chunks
                        SET transcript_text = ?, model = ?, model_name = ?, chunk_size = ?, overlap = ?, created_at = ?
                        WHERE meeting_id = ?
                    """, (transcript_text, model, model_name, chunk_size, overlap, now, meeting_id))

                    # If no rows were updated, insert a new one
                    if cursor.rowcount == 0:
                        await conn.execute("""
                            INSERT INTO transcript_chunks (meeting_id, transcript_text, model, model_name, chunk_size, overlap, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        """, (meeting_id, transcript_text, model, model_name, chunk_size, overlap, now))
                    
                    await conn.commit()
                    logger.info(f"Successfully saved transcript for meeting_id: {meeting_id} (size: {len(transcript_text)} chars)")
                    
                except Exception as e:
                    await conn.rollback()
                    logger.error(f"Failed to save transcript for meeting_id {meeting_id}: {str(e)}", exc_info=True)
                    raise
                    
        except Exception as e:
            logger.error(f"Database connection error in save_transcript: {str(e)}", exc_info=True)
            raise

    async def update_meeting_name(self, meeting_id: str, meeting_name: str):
        """Update meeting name in both meetings and transcript_chunks tables"""
        now = datetime.now(timezone.utc).isoformat()
        async with self._get_connection() as conn:
            # Update meetings table
            await conn.execute("""
                UPDATE meetings
                SET title = ?, updated_at = ?
                WHERE id = ?
            """, (meeting_name, now, meeting_id))
            
            # Update transcript_chunks table
            await conn.execute("""
                UPDATE transcript_chunks
                SET meeting_name = ?
                WHERE meeting_id = ?
            """, (meeting_name, meeting_id))
            
            await conn.commit()

    async def get_transcript_data(self, meeting_id: str):
        """Get transcript data for a meeting"""
        async with self._get_connection() as conn:
            async with conn.execute("""
                SELECT t.*, p.status, p.result, p.error 
                FROM transcript_chunks t 
                JOIN summary_processes p ON t.meeting_id = p.meeting_id 
                WHERE t.meeting_id = ?
            """, (meeting_id,)) as cursor:
                row = await cursor.fetchone()
                if row:
                    return dict(zip([col[0] for col in cursor.description], row))
                return None

    async def save_meeting(self, meeting_id: str, title: str, folder_path: str = None):
        """Save or update a meeting"""
        try:
            async with self._get_connection() as conn:
                cursor = await conn.execute(
                    "SELECT id FROM meetings WHERE id = ? OR title = ?",
                    (meeting_id, title),
                )
                existing_meeting = await cursor.fetchone()

                if not existing_meeting:
                    await conn.execute("""
                        INSERT INTO meetings (id, title, created_at, updated_at, folder_path)
                        VALUES (?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'), ?)
                    """, (meeting_id, title, folder_path))
                    logger.info(f"Saved meeting {meeting_id} with folder_path: {folder_path}")
                else:
                    raise Exception(f"Meeting with ID {meeting_id} already exists")
                await conn.commit()
                return True
        except Exception as e:
            logger.error(f"Error saving meeting: {str(e)}")
            raise

    async def save_meeting_transcript(self, meeting_id: str, transcript: str, timestamp: str,
                                     summary: str = "", action_items: str = "", key_points: str = "",
                                     audio_start_time: float = None, audio_end_time: float = None, duration: float = None):
        """Save a transcript for a meeting with optional recording-relative timestamps"""
        import uuid as _uuid
        try:
            transcript_id = str(_uuid.uuid4())
            async with self._get_connection() as conn:
                await conn.execute("""
                    INSERT INTO transcripts (
                        id, meeting_id, transcript, timestamp, summary, action_items, key_points,
                        audio_start_time, audio_end_time, duration
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (transcript_id, meeting_id, transcript, timestamp, summary, action_items, key_points,
                      audio_start_time, audio_end_time, duration))

                await conn.commit()
                return True
        except Exception as e:
            logger.error(f"Error saving transcript: {str(e)}")
            raise

    async def get_meeting(self, meeting_id: str):
        """Get a meeting by ID with all its transcripts"""
        try:
            async with self._get_connection() as conn:
                # Get meeting details
                cursor = await conn.execute("""
                    SELECT id, title, created_at, updated_at
                    FROM meetings
                    WHERE id = ?
                """, (meeting_id,))
                meeting = await cursor.fetchone()
                
                if not meeting:
                    return None
                
                # Get all transcripts for this meeting with NEW timestamp fields
                cursor = await conn.execute("""
                    SELECT transcript, timestamp, audio_start_time, audio_end_time, duration
                    FROM transcripts
                    WHERE meeting_id = ?
                """, (meeting_id,))
                transcripts = await cursor.fetchall()

                return {
                    'id': meeting[0],
                    'title': meeting[1],
                    'created_at': meeting[2],
                    'updated_at': meeting[3],
                    'transcripts': [{
                        'id': meeting_id,
                        'text': transcript[0],
                        'timestamp': transcript[1],
                        # NEW: Recording-relative timestamps for playback sync
                        'audio_start_time': transcript[2],
                        'audio_end_time': transcript[3],
                        'duration': transcript[4]
                    } for transcript in transcripts]
                }
        except Exception as e:
            logger.error(f"Error getting meeting: {str(e)}")
            raise

    async def update_meeting_title(self, meeting_id: str, new_title: str):
        """Update a meeting's title"""
        now = datetime.now(timezone.utc).isoformat()
        async with self._get_connection() as conn:
            await conn.execute("""
                UPDATE meetings
                SET title = ?, updated_at = ?
                WHERE id = ?
            """, (new_title, now, meeting_id))
            await conn.commit()

    async def get_all_meetings(self):
        """Get all meetings with basic information"""
        async with self._get_connection() as conn:
            cursor = await conn.execute("""
                SELECT id, title, created_at
                FROM meetings
                ORDER BY created_at DESC
            """)
            rows = await cursor.fetchall()
            return [{
                'id': row[0],
                'title': row[1],
                'created_at': row[2]
            } for row in rows]

    async def delete_meeting(self, meeting_id: str):
        """Delete a meeting and all its associated data"""
        if not meeting_id or not meeting_id.strip():
            raise ValueError("meeting_id cannot be empty")
            
        try:
            async with self._get_connection() as conn:
                await conn.execute("BEGIN TRANSACTION")
                
                try:
                    # Check if meeting exists before deletion
                    cursor = await conn.execute("SELECT id FROM meetings WHERE id = ?", (meeting_id,))
                    meeting = await cursor.fetchone()
                    
                    if not meeting:
                        logger.warning(f"Meeting {meeting_id} not found for deletion")
                        await conn.rollback()
                        return False
                    
                    # Delete in proper order to respect foreign key constraints
                    # Delete from transcript_chunks
                    await conn.execute("DELETE FROM transcript_chunks WHERE meeting_id = ?", (meeting_id,))

                    # Delete from summary_processes
                    await conn.execute("DELETE FROM summary_processes WHERE meeting_id = ?", (meeting_id,))

                    # Delete from transcripts
                    await conn.execute("DELETE FROM transcripts WHERE meeting_id = ?", (meeting_id,))

                    # F022: Delete diarization data
                    await conn.execute("DELETE FROM diarization_processes WHERE meeting_id = ?", (meeting_id,))
                    await conn.execute("DELETE FROM speaker_names WHERE meeting_id = ?", (meeting_id,))
                    await conn.execute("DELETE FROM meeting_speakers WHERE meeting_id = ?", (meeting_id,))
                    
                    # Delete from meetings
                    cursor = await conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
                    
                    if cursor.rowcount == 0:
                        logger.error(f"Failed to delete meeting {meeting_id} - no rows affected")
                        await conn.rollback()
                        return False
                    
                    await conn.commit()
                    logger.info(f"Successfully deleted meeting {meeting_id} and all associated data")
                    return True
                    
                except Exception as e:
                    await conn.rollback()
                    logger.error(f"Failed to delete meeting {meeting_id}: {str(e)}", exc_info=True)
                    return False
                    
        except Exception as e:
            logger.error(f"Database connection error in delete_meeting: {str(e)}", exc_info=True)
            return False

    async def get_model_config(self):
        """Get the current model configuration"""
        async with self._get_connection() as conn:
            cursor = await conn.execute("SELECT provider, model, whisperModel FROM settings")
            row = await cursor.fetchone()
            return dict(zip([col[0] for col in cursor.description], row)) if row else None

    async def save_model_config(self, provider: str, model: str, whisperModel: str):
        """Save the model configuration"""
        # Input validation
        if not provider or not provider.strip():
            raise ValueError("Provider cannot be empty")
        if not model or not model.strip():
            raise ValueError("Model cannot be empty")
        if not whisperModel or not whisperModel.strip():
            raise ValueError("Whisper model cannot be empty")
            
        try:
            async with self._get_connection() as conn:
                await conn.execute("BEGIN TRANSACTION")
                
                try:
                    # Check if the configuration already exists
                    cursor = await conn.execute("SELECT id FROM settings")
                    existing_config = await cursor.fetchone()
                    if existing_config:
                        # Update existing configuration
                        await conn.execute("""
                            UPDATE settings 
                            SET provider = ?, model = ?, whisperModel = ?
                            WHERE id = '1'    
                        """, (provider, model, whisperModel))
                    else:
                        # Insert new configuration
                        await conn.execute("""
                            INSERT INTO settings (id, provider, model, whisperModel)
                            VALUES (?, ?, ?, ?)
                        """, ('1', provider, model, whisperModel))
                    
                    await conn.commit()
                    logger.info(f"Successfully saved model configuration: {provider}/{model}")
                    
                except Exception as e:
                    await conn.rollback()
                    logger.error(f"Failed to save model configuration: {str(e)}", exc_info=True)
                    raise
                    
        except Exception as e:
            logger.error(f"Database connection error in save_model_config: {str(e)}", exc_info=True)
            raise


    async def save_api_key(self, api_key: str, provider: str):
        """Save the API key"""
        stmts = _resolve_api_key_sql(provider, _MODEL_API_KEY_SQL)

        try:
            async with self._get_connection() as conn:
                await conn.execute("BEGIN TRANSACTION")

                try:
                    # Check if settings row exists
                    cursor = await conn.execute("SELECT id FROM settings WHERE id = '1'")
                    existing_config = await cursor.fetchone()

                    if existing_config:
                        # Update existing configuration
                        await conn.execute(stmts["update"], (api_key,))
                    else:
                        # Insert new configuration with default values and the API key
                        await conn.execute(stmts["insert"], ('1', 'openai', 'gpt-4o-2024-11-20', 'large-v3', api_key))
                        
                    await conn.commit()
                    logger.info(f"Successfully saved API key for provider: {provider}")
                    
                except Exception as e:
                    await conn.rollback()
                    logger.error(f"Failed to save API key for provider {provider}: {str(e)}", exc_info=True)
                    raise
                    
        except Exception as e:
            logger.error(f"Database connection error in save_api_key: {str(e)}", exc_info=True)
            raise

    async def get_api_key(self, provider: str):
        """Get the API key"""
        stmts = _resolve_api_key_sql(provider, _MODEL_API_KEY_SQL)
        async with self._get_connection() as conn:
            cursor = await conn.execute(stmts["select"])
            row = await cursor.fetchone()
            return row[0] if row and row[0] else ""

    async def get_transcript_config(self):
        """Get the current transcript configuration"""
        async with self._get_connection() as conn:
            cursor = await conn.execute("SELECT provider, model FROM transcript_settings")
            row = await cursor.fetchone()
            if row:
                return dict(zip([col[0] for col in cursor.description], row))
            else:
                # Return default configuration if no transcript settings exist
                return {
                    "provider": "localWhisper",
                    "model": "large-v3"
                }

    async def save_transcript_config(self, provider: str, model: str):
        """Save the transcript settings"""
        # Input validation
        if not provider or not provider.strip():
            raise ValueError("Provider cannot be empty")
        if not model or not model.strip():
            raise ValueError("Model cannot be empty")
            
        try:
            async with self._get_connection() as conn:
                await conn.execute("BEGIN TRANSACTION")
                
                try:
                    # Check if the configuration already exists
                    cursor = await conn.execute("SELECT id FROM transcript_settings")
                    existing_config = await cursor.fetchone()
                    if existing_config:
                        # Update existing configuration
                        await conn.execute("""
                            UPDATE transcript_settings 
                            SET provider = ?, model = ?
                            WHERE id = '1'
                        """, (provider, model))
                    else:
                        # Insert new configuration
                        await conn.execute("""
                            INSERT INTO transcript_settings (id, provider, model)
                            VALUES (?, ?, ?)
                        """, ('1', provider, model))
                    
                    await conn.commit()
                    logger.info(f"Successfully saved transcript configuration: {provider}/{model}")
                    
                except Exception as e:
                    await conn.rollback()
                    logger.error(f"Failed to save transcript configuration: {str(e)}", exc_info=True)
                    raise
                    
        except Exception as e:
            logger.error(f"Database connection error in save_transcript_config: {str(e)}", exc_info=True)
            raise

    async def save_transcript_api_key(self, api_key: str, provider: str):
        """Save the transcript API key"""
        stmts = _resolve_api_key_sql(provider, _TRANSCRIPT_API_KEY_SQL)

        try:
            async with self._get_connection() as conn:
                await conn.execute("BEGIN TRANSACTION")

                try:
                    # Check if transcript settings row exists
                    cursor = await conn.execute("SELECT id FROM transcript_settings WHERE id = '1'")
                    existing_config = await cursor.fetchone()

                    if existing_config:
                        # Update existing configuration
                        await conn.execute(stmts["update"], (api_key,))
                    else:
                        # Insert new configuration with default values and the API key
                        await conn.execute(stmts["insert"], ('1', 'localWhisper', 'large-v3', api_key))
                        
                    await conn.commit()
                    logger.info(f"Successfully saved transcript API key for provider: {provider}")
                    
                except Exception as e:
                    await conn.rollback()
                    logger.error(f"Failed to save transcript API key for provider {provider}: {str(e)}", exc_info=True)
                    raise
                    
        except Exception as e:
            logger.error(f"Database connection error in save_transcript_api_key: {str(e)}", exc_info=True)
            raise


    async def get_transcript_api_key(self, provider: str):
        """Get the transcript API key"""
        stmts = _resolve_api_key_sql(provider, _TRANSCRIPT_API_KEY_SQL)
        async with self._get_connection() as conn:
            cursor = await conn.execute(stmts["select"])
            row = await cursor.fetchone()
            return row[0] if row and row[0] else ""

    async def search_transcripts(self, query: str):
        """Search through meeting transcripts for the given query"""
        if not query or query.strip() == "":
            return []
            
        # Convert query to lowercase for case-insensitive search
        search_query = f"%{query.lower()}%"
        
        try:
            async with self._get_connection() as conn:
                # Search in transcripts table
                cursor = await conn.execute("""
                    SELECT m.id, m.title, t.transcript, t.timestamp
                    FROM meetings m
                    JOIN transcripts t ON m.id = t.meeting_id
                    WHERE LOWER(t.transcript) LIKE ?
                    ORDER BY m.created_at DESC
                """, (search_query,))
                
                rows = await cursor.fetchall()
                
                # Also search in transcript_chunks for full transcripts
                cursor2 = await conn.execute("""
                    SELECT m.id, m.title, tc.transcript_text
                    FROM meetings m
                    JOIN transcript_chunks tc ON m.id = tc.meeting_id
                    WHERE LOWER(tc.transcript_text) LIKE ?
                    AND m.id NOT IN (SELECT DISTINCT meeting_id FROM transcripts WHERE LOWER(transcript) LIKE ?)
                    ORDER BY m.created_at DESC
                """, (search_query, search_query))
                
                chunk_rows = await cursor2.fetchall()
                
                # Format the results
                results = []
                
                # Process transcript matches
                for row in rows:
                    meeting_id, title, transcript, timestamp = row
                    
                    # Find the matching context (snippet around the match)
                    transcript_lower = transcript.lower()
                    match_index = transcript_lower.find(query.lower())
                    
                    # Extract context around the match (100 chars before and after)
                    start_index = max(0, match_index - 100)
                    end_index = min(len(transcript), match_index + len(query) + 100)
                    context = transcript[start_index:end_index]
                    
                    # Add ellipsis if we truncated the text
                    if start_index > 0:
                        context = "..." + context
                    if end_index < len(transcript):
                        context += "..."
                    
                    results.append({
                        'id': meeting_id,
                        'title': title,
                        'matchContext': context,
                        'timestamp': timestamp
                    })
                
                # Process transcript_chunks matches
                for row in chunk_rows:
                    meeting_id, title, transcript_text = row
                    
                    # Find the matching context (snippet around the match)
                    transcript_lower = transcript_text.lower()
                    match_index = transcript_lower.find(query.lower())
                    
                    # Extract context around the match (100 chars before and after)
                    start_index = max(0, match_index - 100)
                    end_index = min(len(transcript_text), match_index + len(query) + 100)
                    context = transcript_text[start_index:end_index]
                    
                    # Add ellipsis if we truncated the text
                    if start_index > 0:
                        context = "..." + context
                    if end_index < len(transcript_text):
                        context += "..."
                    
                    results.append({
                        'id': meeting_id,
                        'title': title,
                        'matchContext': context,
                        'timestamp': datetime.now(timezone.utc).isoformat()  # Use current time as fallback
                    })
                
                return results
                
        except Exception as e:
            logger.error(f"Error searching transcripts: {str(e)}")
            raise
        
    async def delete_api_key(self, provider: str):
        """Delete the API key"""
        stmts = _resolve_api_key_sql(provider, _MODEL_API_KEY_SQL)
        async with self._get_connection() as conn:
            await conn.execute(stmts["clear"])
            await conn.commit()
    
    # ------------------------------------------------------------------
    # F022: Speaker Diarization CRUD
    # ------------------------------------------------------------------

    async def create_diarization_process(self, meeting_id: str) -> str:
        """Create or reset a diarization process entry."""
        now = datetime.now(timezone.utc).isoformat()
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "UPDATE diarization_processes SET status = 'pending', progress_pct = 0, "
                "error = NULL, result = NULL, updated_at = ? WHERE meeting_id = ?",
                (now, meeting_id),
            )
            if cursor.rowcount == 0:
                await conn.execute(
                    "INSERT INTO diarization_processes (meeting_id, status, progress_pct, created_at, updated_at) "
                    "VALUES (?, 'pending', 0, ?, ?)",
                    (meeting_id, now, now),
                )
            await conn.commit()
        return meeting_id

    async def update_diarization_process(
        self,
        meeting_id: str,
        status: str,
        progress_pct: int = 0,
        result: Optional[Dict] = None,
        error: Optional[str] = None,
        num_speakers: Optional[int] = None,
        processing_time: Optional[float] = None,
    ):
        """Update diarization process status."""
        now = datetime.now(timezone.utc).isoformat()
        fields = ["status = ?", "progress_pct = ?", "updated_at = ?"]
        params: list = [status, progress_pct, now]

        if result is not None:
            fields.append("result = ?")
            params.append(json.dumps(result))
        if error is not None:
            fields.append("error = ?")
            params.append(str(error)[:1000])
        if num_speakers is not None:
            fields.append("num_speakers = ?")
            params.append(num_speakers)
        if processing_time is not None:
            fields.append("processing_time = ?")
            params.append(processing_time)

        params.append(meeting_id)
        async with self._get_connection() as conn:
            await conn.execute(
                f"UPDATE diarization_processes SET {', '.join(fields)} WHERE meeting_id = ?",
                params,
            )
            await conn.commit()

    async def get_diarization_status(self, meeting_id: str) -> Optional[Dict]:
        """Get diarization process status for a meeting."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT meeting_id, status, progress_pct, num_speakers, error, processing_time "
                "FROM diarization_processes WHERE meeting_id = ?",
                (meeting_id,),
            )
            row = await cursor.fetchone()
            if not row:
                return None
            return {
                "meeting_id": row[0],
                "status": row[1],
                "progress_pct": row[2],
                "num_speakers": row[3],
                "error": row[4],
                "processing_time": row[5],
            }

    async def get_diarization_result(self, meeting_id: str) -> Optional[Dict]:
        """Get full diarization result JSON for a meeting."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT result FROM diarization_processes WHERE meeting_id = ? AND status = 'completed'",
                (meeting_id,),
            )
            row = await cursor.fetchone()
            if row and row[0]:
                return json.loads(row[0])
            return None

    async def save_speaker_names(self, meeting_id: str, speaker_names: Dict[str, str]):
        """Save or update speaker display names for a meeting."""
        async with self._get_connection() as conn:
            for label, name in speaker_names.items():
                await conn.execute(
                    "INSERT INTO speaker_names (meeting_id, speaker_label, display_name) "
                    "VALUES (?, ?, ?) ON CONFLICT(meeting_id, speaker_label) "
                    "DO UPDATE SET display_name = ?",
                    (meeting_id, label, name, name),
                )
            await conn.commit()

    async def get_speaker_names(self, meeting_id: str) -> Dict[str, str]:
        """Get speaker display names for a meeting."""
        async with self._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT speaker_label, display_name FROM speaker_names WHERE meeting_id = ?",
                (meeting_id,),
            )
            rows = await cursor.fetchall()
            return {row[0]: row[1] for row in rows if row[1]}

    async def update_meeting_summary(self, meeting_id: str, summary: dict):
        """Update a meeting's summary"""
        now = datetime.now(timezone.utc).isoformat()
        try:
            async with self._get_connection() as conn:
                # Check if the meeting exists
                cursor = await conn.execute("SELECT id FROM meetings WHERE id = ?", (meeting_id,))
                meeting = await cursor.fetchone()
                
                if not meeting:
                    raise ValueError(f"Meeting with ID {meeting_id} not found")
                
                # Update the summary in the summary_processes table
                await conn.execute("""
                    UPDATE summary_processes
                    SET result = ?, updated_at = ?
                    WHERE meeting_id = ?
                """, (json.dumps(summary), now, meeting_id))
                
                # Update the meeting's updated_at timestamp
                await conn.execute("""
                    UPDATE meetings
                    SET updated_at = ?
                    WHERE id = ?
                """, (now, meeting_id))
                
                await conn.commit()
                return True
        except Exception as e:
            logger.error(f"Error updating meeting summary: {str(e)}")
            raise

   

