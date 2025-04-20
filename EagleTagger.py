import os
import json
import tkinter as tk
from tkinter import filedialog, scrolledtext, messagebox
from tkinter import ttk
import threading
import multiprocessing
from concurrent.futures import ProcessPoolExecutor, as_completed
import time
import csv
from datetime import datetime
import hashlib
import sqlite3
from collections import defaultdict

class TagMergerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Metadata Tag Merger")
        self.root.geometry("800x700")
        self.root.configure(bg="#2d2d2d")
        
        # Processing state
        self.processing = False
        self.cancel_requested = False
        
        # Set dark theme
        self.style = ttk.Style()
        self.style.theme_use("clam")
        self.style.configure("TButton", background="#3d3d3d", foreground="#ffffff", borderwidth=1, focusthickness=3, focuscolor="none")
        self.style.map('TButton', background=[('active', '#4d4d4d')])
        self.style.configure("TFrame", background="#2d2d2d")
        self.style.configure("TLabel", background="#2d2d2d", foreground="#ffffff")
        self.style.configure("TRadiobutton", background="#2d2d2d", foreground="#ffffff")
        self.style.configure("TListbox", background="#3d3d3d", foreground="#ffffff")
        
        # Configure progress bar style for dark theme
        self.style.configure("TProgressbar", 
                             background="#4d9dff",
                             troughcolor="#2d2d2d",
                             borderwidth=0,
                             thickness=20)
        
        # Variables
        self.tags_folders = []
        self.metadata_folders = []
        self.process_mode = tk.StringVar(value="all")
        self.index_mode = tk.StringVar(value="use_index")  # Default: use existing index
        self.progress_var = tk.DoubleVar(value=0.0)
        
        # Main frame
        main_frame = ttk.Frame(root)
        main_frame.pack(padx=20, pady=20, fill=tk.BOTH, expand=True)
        
        # Tags folder selection
        ttk.Label(main_frame, text="Tags JSON Folders:").pack(anchor=tk.W, pady=(0, 5))
        
        # Frame for tag folders listbox and buttons
        tags_list_frame = ttk.Frame(main_frame)
        tags_list_frame.pack(fill=tk.X, pady=(0, 10))
        
        # Tag folders listbox
        self.tags_listbox = tk.Listbox(tags_list_frame, bg="#3d3d3d", fg="#ffffff", height=4)
        self.tags_listbox.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))
        
        # Scrollbar for tag folders listbox
        tags_scroll = ttk.Scrollbar(tags_list_frame, command=self.tags_listbox.yview)
        tags_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.tags_listbox.config(yscrollcommand=tags_scroll.set)
        
        # Buttons for tag folders
        tags_btn_frame = ttk.Frame(main_frame)
        tags_btn_frame.pack(fill=tk.X, pady=(0, 10))
        
        add_tags_btn = ttk.Button(tags_btn_frame, text="Add Folder", command=self.add_tags_folder)
        add_tags_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        remove_tags_btn = ttk.Button(tags_btn_frame, text="Remove Selected", command=self.remove_tags_folder)
        remove_tags_btn.pack(side=tk.LEFT)
        
        # Metadata folder selection
        ttk.Label(main_frame, text="Metadata Search Folders:").pack(anchor=tk.W, pady=(0, 5))
        
        # Frame for metadata folders listbox and buttons
        meta_list_frame = ttk.Frame(main_frame)
        meta_list_frame.pack(fill=tk.X, pady=(0, 10))
        
        # Metadata folders listbox
        self.meta_listbox = tk.Listbox(meta_list_frame, bg="#3d3d3d", fg="#ffffff", height=4)
        self.meta_listbox.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))
        
        # Scrollbar for metadata folders listbox
        meta_scroll = ttk.Scrollbar(meta_list_frame, command=self.meta_listbox.yview)
        meta_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.meta_listbox.config(yscrollcommand=meta_scroll.set)
        
        # Buttons for metadata folders
        meta_btn_frame = ttk.Frame(main_frame)
        meta_btn_frame.pack(fill=tk.X, pady=(0, 10))
        
        add_meta_btn = ttk.Button(meta_btn_frame, text="Add Folder", command=self.add_metadata_folder)
        add_meta_btn.pack(side=tk.LEFT, padx=(0, 5))
        
        remove_meta_btn = ttk.Button(meta_btn_frame, text="Remove Selected", command=self.remove_metadata_folder)
        remove_meta_btn.pack(side=tk.LEFT)
        
        # Processing mode selection
        mode_frame = ttk.Frame(main_frame)
        mode_frame.pack(fill=tk.X, pady=5)
        
        ttk.Label(mode_frame, text="Processing Mode:").pack(anchor=tk.W, pady=(0, 5))
        
        all_radio = ttk.Radiobutton(mode_frame, text="Process All Files", variable=self.process_mode, value="all")
        all_radio.pack(anchor=tk.W)
        
        new_radio = ttk.Radiobutton(mode_frame, text="Process Only New Files", variable=self.process_mode, value="new")
        new_radio.pack(anchor=tk.W)
        
        # Index mode selection
        index_frame = ttk.Frame(main_frame)
        index_frame.pack(fill=tk.X, pady=5)
        
        ttk.Label(index_frame, text="Index Mode:").pack(anchor=tk.W, pady=(0, 5))
        
        use_index_radio = ttk.Radiobutton(index_frame, text="Use Existing Index (Fastest)", variable=self.index_mode, value="use_index")
        use_index_radio.pack(anchor=tk.W)

        smart_search_radio = ttk.Radiobutton(index_frame, text="Smart Search (Balanced)", variable=self.index_mode, value="smart")
        smart_search_radio.pack(anchor=tk.W)
        
        rebuild_index_radio = ttk.Radiobutton(index_frame, text="Rebuild Index (Most Thorough)", variable=self.index_mode, value="rebuild")
        rebuild_index_radio.pack(anchor=tk.W)
        
        # Process/Cancel buttons frame
        buttons_frame = ttk.Frame(main_frame)
        buttons_frame.pack(pady=10)
        
        # Process button
        self.process_button = ttk.Button(buttons_frame, text="Process Files", command=self.start_processing)
        self.process_button.pack(side=tk.LEFT, padx=(0, 10))
        
        # Cancel button
        self.cancel_button = ttk.Button(buttons_frame, text="Cancel", command=self.cancel_processing, state=tk.DISABLED)
        self.cancel_button.pack(side=tk.LEFT)
        
        # Progress bar
        progress_frame = ttk.Frame(main_frame)
        progress_frame.pack(fill=tk.X, pady=(0, 5))
        
        self.progress_bar = ttk.Progressbar(
            progress_frame, 
            orient=tk.HORIZONTAL, 
            length=100, 
            mode='determinate',
            variable=self.progress_var,
            style="TProgressbar"
        )
        self.progress_bar.pack(fill=tk.X)
        
        # Progress tracking
        self.progress_frame = ttk.Frame(main_frame)
        self.progress_frame.pack(fill=tk.X, pady=5)
        self.progress_label = ttk.Label(self.progress_frame, text="Ready")
        self.progress_label.pack(anchor=tk.W)
        
        # Log area
        ttk.Label(main_frame, text="Log:").pack(anchor=tk.W, pady=(5, 5))
        self.log_area = scrolledtext.ScrolledText(main_frame, bg="#3d3d3d", fg="#ffffff", height=10)
        self.log_area.pack(fill=tk.BOTH, expand=True)
        self.log_area.configure(state=tk.DISABLED)
        
        # Set up close handler to properly shut down
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
    
    def on_close(self):
        """Handle window close event to properly clean up"""
        if self.processing:
            if messagebox.askyesno("Processing in Progress", 
                                      "Processing is still running. Are you sure you want to exit? All progress will be lost."):
                self.cancel_processing()
                self.root.after(1000, self.root.destroy)  # Give time for cleanup
            # Don't close if they answer no
        else:
            self.root.destroy()
    
    def add_tags_folder(self):
        folder = filedialog.askdirectory()
        if folder and folder not in self.tags_folders:
            self.tags_folders.append(folder)
            self.tags_listbox.insert(tk.END, folder)
    
    def remove_tags_folder(self):
        selected = self.tags_listbox.curselection()
        if selected:
            index = selected[0]
            self.tags_listbox.delete(index)
            del self.tags_folders[index]
    
    def add_metadata_folder(self):
        folder = filedialog.askdirectory()
        if folder and folder not in self.metadata_folders:
            self.metadata_folders.append(folder)
            self.meta_listbox.insert(tk.END, folder)
    
    def remove_metadata_folder(self):
        selected = self.meta_listbox.curselection()
        if selected:
            index = selected[0]
            self.meta_listbox.delete(index)
            del self.metadata_folders[index]
    
    def log(self, message):
        self.log_area.configure(state=tk.NORMAL)
        self.log_area.insert(tk.END, message + "\n")
        self.log_area.see(tk.END)
        self.log_area.configure(state=tk.DISABLED)
    
    def update_progress(self, message, progress_value=None):
        self.progress_label.configure(text=message)
        if progress_value is not None:
            self.progress_var.set(progress_value)
        self.root.update_idletasks()
    
    def start_processing(self):
        # Validate inputs
        if not self.tags_folders or not self.metadata_folders:
            self.log("Error: Please select at least one folder for each category.")
            return
        
        # Clear log
        self.log_area.configure(state=tk.NORMAL)
        self.log_area.delete(1.0, tk.END)
        self.log_area.configure(state=tk.DISABLED)
        
        # Reset progress bar
        self.progress_var.set(0)
        
        # Update UI state for processing
        self.processing = True
        self.cancel_requested = False
        self.process_button.configure(state=tk.DISABLED)
        self.cancel_button.configure(state=tk.NORMAL)
        
        # Start processing in a separate thread
        threading.Thread(target=self.process_files, daemon=True).start()
    
    def cancel_processing(self):
        """Request processing to be cancelled"""
        if self.processing:
            self.cancel_requested = True
            self.log("Cancellation requested. Waiting for current operations to complete...")
            self.cancel_button.configure(state=tk.DISABLED)
    
    def get_index_db_path(self):
        """Get the path to the SQLite index database"""
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "tag_index.db")
    
    def initialize_index_db(self, db_path):
        """Initialize the SQLite index database"""
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Create tables if they don't exist
        cursor.execute('''
        CREATE TABLE IF NOT EXISTS tag_files (
            id INTEGER PRIMARY KEY,
            filepath TEXT UNIQUE,
            name TEXT,
            mtime REAL,
            size INTEGER
        )
        ''')
        
        cursor.execute('''
        CREATE TABLE IF NOT EXISTS metadata_files (
            id INTEGER PRIMARY KEY,
            filepath TEXT UNIQUE,
            name TEXT,
            size INTEGER,
            mtime REAL,
            processed INTEGER DEFAULT 0,
            resumed INTEGER DEFAULT 0
        )
        ''')
        
        # Add a table to track processing state for resumability
        cursor.execute('''
        CREATE TABLE IF NOT EXISTS processing_state (
            id INTEGER PRIMARY KEY,
            last_processed_id INTEGER,
            mode TEXT,
            index_mode TEXT,
            timestamp TEXT
        )
        ''')
        
        # Create indices for faster lookups
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_tag_name ON tag_files (name)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_metadata_name ON metadata_files (name)')
        
        conn.commit()
        return conn
    
    def rebuild_tag_index(self, conn, cursor):
        """Rebuild the tag files index"""
        cursor.execute('DELETE FROM tag_files')
        conn.commit()
        
        total_files = 0
        for tags_folder in self.tags_folders:
            if self.cancel_requested:
                break
                
            for root, _, files in os.walk(tags_folder):
                if self.cancel_requested:
                    break
                    
                for file in files:
                    if self.cancel_requested:
                        break
                        
                    if file.lower().endswith('.json'):
                        filepath = os.path.join(root, file)
                        name = os.path.splitext(file)[0]
                        try:
                            file_stat = os.stat(filepath)
                            size = file_stat.st_size
                            mtime = file_stat.st_mtime
                            
                            cursor.execute(
                                'INSERT OR REPLACE INTO tag_files (filepath, name, mtime, size) VALUES (?, ?, ?, ?)',
                                (filepath, name, mtime, size)
                            )
                            total_files += 1
                            
                            # Commit in batches for better performance
                            if total_files % 1000 == 0:
                                conn.commit()
                                
                        except Exception as e:
                            self.log(f"Error indexing tag file {filepath}: {str(e)}")
        
        conn.commit()
        return total_files
    
    def update_tag_index(self, conn, cursor):
        """Update the tag files index by checking for new/modified files"""
        # Get existing records
        cursor.execute('SELECT filepath, mtime FROM tag_files')
        existing_files = {row[0]: row[1] for row in cursor.fetchall()}
        
        # Track folders already in the index
        indexed_folders = set()
        for filepath in existing_files:
            folder = os.path.dirname(filepath)
            indexed_folders.add(folder)
        
        # Track current folders
        current_folders = set()
        for tags_folder in self.tags_folders:
            for root, _, _ in os.walk(tags_folder):
                current_folders.add(root)
        
        # Find and remove files that no longer exist
        for filepath in list(existing_files.keys()):
            if self.cancel_requested:
                break
                
            if not os.path.exists(filepath) or os.path.dirname(filepath) not in current_folders:
                cursor.execute('DELETE FROM tag_files WHERE filepath = ?', (filepath,))
        
        # Find and add new/modified files
        updated_files = 0
        new_files = 0
        
        for tags_folder in self.tags_folders:
            if self.cancel_requested:
                break
                
            for root, _, files in os.walk(tags_folder):
                if self.cancel_requested:
                    break
                    
                for file in files:
                    if self.cancel_requested:
                        break
                        
                    if file.lower().endswith('.json'):
                        filepath = os.path.join(root, file)
                        name = os.path.splitext(file)[0]
                        
                        try:
                            file_stat = os.stat(filepath)
                            size = file_stat.st_size
                            mtime = file_stat.st_mtime
                            
                            if filepath in existing_files:
                                # File exists, check if modified
                                if mtime > existing_files[filepath]:
                                    cursor.execute(
                                        'UPDATE tag_files SET mtime = ?, size = ? WHERE filepath = ?',
                                        (mtime, size, filepath)
                                    )
                                    updated_files += 1
                            else:
                                # New file
                                cursor.execute(
                                    'INSERT INTO tag_files (filepath, name, mtime, size) VALUES (?, ?, ?, ?)',
                                    (filepath, name, mtime, size)
                                )
                                new_files += 1
                            
                            # Commit in batches
                            if (updated_files + new_files) % 1000 == 0:
                                conn.commit()
                                
                        except Exception as e:
                            self.log(f"Error indexing tag file {filepath}: {str(e)}")
        
        conn.commit()
        return new_files, updated_files
    
    def build_metadata_index(self, conn, cursor):
        """Build or update the metadata files index"""
        if self.index_mode.get() == "rebuild":
            # Clear existing metadata index if rebuilding
            cursor.execute('DELETE FROM metadata_files')
            conn.commit()
        
        # Get existing metadata files
        cursor.execute('SELECT filepath, mtime FROM metadata_files')
        existing_files = {row[0]: row[1] for row in cursor.fetchall()}
        
        # Track current folders for cleanup
        current_folders = set()
        for metadata_folder in self.metadata_folders:
            for root, _, _ in os.walk(metadata_folder):
                current_folders.add(root)
        
        # Remove files that no longer exist
        for filepath in list(existing_files.keys()):
            if self.cancel_requested:
                break
                
            if not os.path.exists(filepath) or os.path.dirname(filepath) not in current_folders:
                cursor.execute('DELETE FROM metadata_files WHERE filepath = ?', (filepath,))
        
        # Find new/modified metadata files
        total_files = 0
        processed_files = 0
        skipped_files = 0
        
        # Get list of already processed files if in "new only" mode
        if self.process_mode.get() == "new":
            cursor.execute('SELECT filepath FROM metadata_files WHERE processed = 1')
            processed_filepaths = {row[0] for row in cursor.fetchall()}
        else:
            processed_filepaths = set()
        
        for metadata_folder in self.metadata_folders:
            if self.cancel_requested:
                break
                
            for root, _, files in os.walk(metadata_folder):
                if self.cancel_requested:
                    break
                    
                for file in files:
                    if self.cancel_requested:
                        break
                        
                    if file.lower() == 'metadata.json':
                        filepath = os.path.join(root, file)
                        
                        # Skip if processing only new files and this file has been processed before
                        if self.process_mode.get() == "new" and filepath in processed_filepaths:
                            skipped_files += 1
                            continue
                        
                        try:
                            # Read metadata file to get name and size
                            with open(filepath, 'r', encoding='utf-8') as f:
                                metadata = json.load(f)
                            
                            # Check if metadata has required fields
                            if 'name' not in metadata or 'size' not in metadata:
                                continue
                                
                            name = metadata['name']
                            size = metadata['size']
                            file_stat = os.stat(filepath)
                            mtime = file_stat.st_mtime
                            
                            if filepath in existing_files:
                                # Update if modified
                                if mtime > existing_files[filepath]:
                                    cursor.execute(
                                        'UPDATE metadata_files SET name = ?, size = ?, mtime = ? WHERE filepath = ?',
                                        (name, size, mtime, filepath)
                                    )
                            else:
                                # New file
                                cursor.execute(
                                    'INSERT INTO metadata_files (filepath, name, size, mtime, processed, resumed) VALUES (?, ?, ?, ?, 0, 0)',
                                    (filepath, name, size, mtime)
                                )
                            
                            total_files += 1
                            
                            # Commit in batches
                            if total_files % 1000 == 0:
                                conn.commit()
                                
                        except Exception as e:
                            self.log(f"Error indexing metadata file {filepath}: {str(e)}")
        
        conn.commit()
        return total_files, skipped_files
    
    def check_resumable_processing(self, conn, cursor):
        """Check if there's a previous processing state to resume"""
        cursor.execute('SELECT * FROM processing_state ORDER BY id DESC LIMIT 1')
        state = cursor.fetchone()
        
        if state and self.process_mode.get() == "new":
            last_id, mode, index_mode, timestamp = state[1], state[2], state[3], state[4]
            
            # Only resume if modes match
            if mode == self.process_mode.get() and index_mode == self.index_mode.get():
                cursor.execute('SELECT COUNT(*) FROM metadata_files WHERE id > ? AND processed = 0', (last_id,))
                remaining = cursor.fetchone()[0]
                
                if remaining > 0:
                    if messagebox.askyesno("Resume Processing", 
                                            f"Found incomplete processing from {timestamp}.\n"
                                            f"There are {remaining} files left to process.\n"
                                            f"Would you like to resume processing?"):
                        # Mark files as resumed
                        cursor.execute('UPDATE metadata_files SET resumed = 1 WHERE id > ? AND processed = 0', (last_id,))
                        conn.commit()
                        return last_id
        
        return None
    
    def save_processing_state(self, conn, cursor, last_processed_id):
        """Save current processing state for potential resumption"""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute(
            'INSERT INTO processing_state (last_processed_id, mode, index_mode, timestamp) VALUES (?, ?, ?, ?)',
            (last_processed_id, self.process_mode.get(), self.index_mode.get(), timestamp)
        )
        conn.commit()
    
    def append_to_processed_log(self, results):
        """Append processed files to processed.log"""
        log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "processed.log")
        
        # Create log file with header if it doesn't exist
        if not os.path.exists(log_path):
            with open(log_path, 'w', encoding='utf-8', newline='') as f:
                writer = csv.writer(f)
                writer.writerow(["Filepath", "Name", "Size", "Timestamp", "Updated", "Tags Added"])
        
        # Append new entries
        with open(log_path, 'a', encoding='utf-8', newline='') as f:
            writer = csv.writer(f)
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            
            for result in results:
                if 'filepath' in result:
                    row = [
                        result['filepath'],
                        result.get('name', ''),
                        result.get('size', ''),
                        timestamp,
                        str(result.get('updated', False)),
                        str(result.get('added_tags', 0))
                    ]
                    writer.writerow(row)
    
    def process_files(self):
        try:
            start_time = time.time()
            self.log("Starting processing...")
            
            # Set initial progress
            self.update_progress("Initializing...", 0)
            
            # Initialize database
            db_path = self.get_index_db_path()
            conn = self.initialize_index_db(db_path)
            cursor = conn.cursor()
            
            # Set mode flags in the database
            if self.index_mode.get() == "rebuild":
                cursor.execute('PRAGMA user_version = 1')  # 1 = rebuild mode
            elif self.index_mode.get() == "smart":
                cursor.execute('PRAGMA user_version = 2')  # 2 = smart mode
            else:
                cursor.execute('PRAGMA user_version = 0')  # 0 = use existing
            conn.commit()
            
            # Check for resumable processing
            resume_from_id = self.check_resumable_processing(conn, cursor)
            
            # Build or update tag index
            self.update_progress("Indexing tag files...", 5)
            if self.index_mode.get() == "rebuild":
                self.log("Rebuilding tag file index...")
                total_tag_files = self.rebuild_tag_index(conn, cursor)
                self.log(f"Indexed {total_tag_files} tag files in {time.time() - start_time:.2f} seconds")
            else:
                self.log("Updating tag file index...")
                new_files, updated_files = self.update_tag_index(conn, cursor)
                self.log(f"Updated tag index: {new_files} new files, {updated_files} updated files in {time.time() - start_time:.2f} seconds")
            
            if self.cancel_requested:
                self.log("Processing cancelled during tag indexing.")
                conn.close()
                self.cleanup_after_processing()
                return
            
            # Build metadata index and get files to process
            self.update_progress("Indexing metadata files...", 15)
            total_metadata_files, skipped_files = self.build_metadata_index(conn, cursor)
            
            self.log(f"Found {total_metadata_files} metadata files to process (skipped {skipped_files}) in {time.time() - start_time:.2f} seconds")
            
            if self.cancel_requested:
                self.log("Processing cancelled during metadata indexing.")
                conn.close()
                self.cleanup_after_processing()
                return
            
            # Get the list of metadata files to process
            if resume_from_id:
                cursor.execute('SELECT id, filepath, name, size FROM metadata_files WHERE processed = 0 AND id > ? ORDER BY id', (resume_from_id,))
                self.log(f"Resuming processing from ID {resume_from_id}")
            elif self.process_mode.get() == "new":
                cursor.execute('SELECT id, filepath, name, size FROM metadata_files WHERE processed = 0 ORDER BY id')
            else:
                cursor.execute('SELECT id, filepath, name, size FROM metadata_files ORDER BY id')
            
            metadata_files = [(row[0], row[1], row[2], row[3]) for row in cursor.fetchall()]
            
            if not metadata_files:
                self.log("No metadata files found to process. Exiting.")
                self.update_progress("Complete - No files found", 100)
                conn.close()
                self.cleanup_after_processing()
                return
            
            # Step 3: Process metadata files in parallel
            self.update_progress("Processing metadata files...", 20)
            
            # Optimize CPU usage for your specific CPU
            cpu_count = multiprocessing.cpu_count()
            workers = max(1, min(cpu_count, 32))  # Cap at 32 workers
            
            # Adjust chunk size for optimal performance
            chunk_size = max(1, min(100, len(metadata_files) // workers))
            
            # Split files into chunks for processing
            def chunks(lst, n):
                for i in range(0, len(lst), n):
                    yield lst[i:i + n]
            
            results = []
            metadata_files_updated = 0
            last_processed_id = 0
            
            # Calculate progress increments
            progress_start = 20
            progress_end = 95
            progress_increment = (progress_end - progress_start) / len(metadata_files)
            current_progress = progress_start
            
            with ProcessPoolExecutor(max_workers=workers) as executor:
                futures = {
                    executor.submit(
                        self.process_metadata_chunk, 
                        chunk, 
                        db_path
                    ): i for i, chunk in enumerate(chunks(metadata_files, chunk_size))
                }
                
                self.log(f"Processing with {workers} workers, {len(futures)} chunks of {chunk_size} files each")
                
                completed_files = 0
                for future in as_completed(futures):
                    if self.cancel_requested:
                        for f in futures:
                            f.cancel()
                        break
                    
                    try:
                        chunk_results = future.result()
                        
                        # Update database to mark files as processed
                        for result in chunk_results:
                            if 'id' in result:
                                cursor.execute('UPDATE metadata_files SET processed = 1 WHERE id = ?', (result['id'],))
                                last_processed_id = max(last_processed_id, result['id'])
                        
                        conn.commit()
                        
                        results.extend(chunk_results)
                        
                        # Update progress based on completed files
                        completed_files += len(chunk_results)
                        current_progress = progress_start + (completed_files * progress_increment)
                        self.update_progress(
                            f"Processing metadata files... {completed_files}/{len(metadata_files)}", 
                            min(current_progress, progress_end)
                        )
                        
                        # Count updated files
                        for r in chunk_results:
                            if r.get('updated', False):
                                metadata_files_updated += 1
                                
                        # Batch log only a summary to avoid GUI slowdown
                        if len(chunk_results) > 0:
                            updated_in_chunk = sum(1 for r in chunk_results if r.get('updated', False))
                            self.log(f"Processed {len(chunk_results)} files, updated {updated_in_chunk}")
                    except Exception as e:
                        self.log(f"Error processing chunk: {str(e)}")
            
            # If processing was cancelled, save state for resumption
            if self.cancel_requested:
                self.save_processing_state(conn, cursor, last_processed_id)
                self.log("Processing cancelled. Progress has been saved for resumption.")
            
            # Close database connection
            conn.close()
            
            # Update the processed.log file
            if not self.cancel_requested:
                self.update_progress("Updating processed files log...", 95)
                self.append_to_processed_log(results)
                
                elapsed_time = time.time() - start_time
                self.log(f"Processing complete in {elapsed_time:.2f} seconds. Found {len(metadata_files)} metadata files, updated {metadata_files_updated} files.")
                self.update_progress(f"Complete - Processed {len(metadata_files)} files in {elapsed_time:.2f}s", 100)
            
            # Reset UI state
            self.cleanup_after_processing()
            
        except Exception as e:
            self.log(f"Error in processing: {str(e)}")
            self.cleanup_after_processing()
    
    def cleanup_after_processing(self):
        """Reset UI state after processing completes or is cancelled"""
        self.processing = False
        self.process_button.configure(state=tk.NORMAL)
        self.cancel_button.configure(state=tk.DISABLED)
    
    @staticmethod
    def process_metadata_chunk(metadata_files, db_path):
        """Process a chunk of metadata files"""
        results = []
        
        # Connect to the database for this worker
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        for file_id, metadata_path, metadata_name, metadata_size in metadata_files:
            try:
                # Read metadata file
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                
                # Check if metadata has required fields
                if 'tags' not in metadata:
                    results.append({
                        'id': file_id,
                        'name': metadata_name,
                        'filepath': metadata_path,
                        'updated': False,
                        'error': 'Missing tags field'
                    })
                    continue
                
                found_match = False
                
                # Direct exact name match - using the numeric filename without checking file size
                cursor.execute('SELECT filepath FROM tag_files WHERE name = ?', (metadata_name,))
                matching_tag_files = [row[0] for row in cursor.fetchall()]
                
                # Check each matching tag file
                for tag_file_path in matching_tag_files:
                    try:
                        with open(tag_file_path, 'r', encoding='utf-8') as f:
                            tag_data = json.load(f)
                        
                        # Process tag data without checking file size
                        if isinstance(tag_data, list) and len(tag_data) > 0:
                            # Format: array with objects
                            for item in tag_data:
                                if 'tags' in item:
                                    # We have a match by name!
                                    updated, added_tags = TagMergerApp.process_tags(metadata, item['tags'], metadata_path)
                                    found_match = True
                                    results.append({
                                        'id': file_id,
                                        'name': metadata_name,
                                        'filepath': metadata_path,
                                        'size': metadata_size,
                                        'updated': updated,
                                        'added_tags': added_tags
                                    })
                                    break
                        elif isinstance(tag_data, dict) and 'tags' in tag_data:
                            # Format: direct object
                            updated, added_tags = TagMergerApp.process_tags(metadata, tag_data['tags'], metadata_path)
                            found_match = True
                            results.append({
                                'id': file_id,
                                'name': metadata_name,
                                'filepath': metadata_path,
                                'size': metadata_size,
                                'updated': updated,
                                'added_tags': added_tags
                            })
                        
                        if found_match:
                            break
                    except Exception:
                        # Continue to next file if there's an error
                        continue
                
                if not found_match:
                    results.append({
                        'id': file_id,
                        'name': metadata_name,
                        'filepath': metadata_path,
                        'size': metadata_size,
                        'updated': False
                    })
            
            except Exception as e:
                results.append({
                    'id': file_id,
                    'name': os.path.basename(metadata_path),
                    'filepath': metadata_path,
                    'updated': False,
                    'error': str(e)
                })
        
        # Close this worker's connection
        conn.close()
        
        return results
    
    @staticmethod
    def process_tags(metadata, tag_data, metadata_path):
        # Get current tags from metadata
        current_tags = set(metadata['tags'])
        added_tags = 0
        
        # Process tags based on format
        if isinstance(tag_data, dict):
            # Format: {"tag1": 0.95, "tag2": 0.85, ...}
            # Extract just the tag names, ignoring confidence values
            for tag in tag_data.keys():
                if tag not in current_tags:
                    current_tags.add(tag)
                    added_tags += 1
        elif isinstance(tag_data, list):
            # Format: ["tag1", "tag2", ...]
            for tag in tag_data:
                if tag not in current_tags:
                    current_tags.add(tag)
                    added_tags += 1
        
        # Update metadata if tags were added
        if added_tags > 0:
            metadata['tags'] = list(current_tags)
            
            # Write updated metadata with compact format (no whitespace)
            with open(metadata_path, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, separators=(',', ':'))
            
            return True, added_tags
        else:
            return False, 0

if __name__ == "__main__":
    multiprocessing.freeze_support()  # Needed for Windows executables
    root = tk.Tk()
    app = TagMergerApp(root)
    root.mainloop()
