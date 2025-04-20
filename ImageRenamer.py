import concurrent.futures
import os
import sys
import random
import sqlite3
import time
import threading
from datetime import datetime
from pathlib import Path
from tkinter import *
from tkinter import ttk, filedialog, messagebox
from PIL import Image
import multiprocessing

# Thread-local storage for database connections
thread_local = threading.local()

class ImageRenamer:
    def __init__(self, root):
        self.root = root
        self.root.title("Image Renamer")
        self.root.geometry("800x600")
        self.root.configure(bg="#2d2d2d")
        
        # Number of worker threads (based on CPU cores)
        self.num_workers = min(32, multiprocessing.cpu_count() * 2)  # Use up to 32 threads
        
        # Create a lock for database operations
        self.db_lock = threading.Lock()
        
        # Configure styles for dark mode
        self.style = ttk.Style()
        self.style.theme_use("clam")
        self.style.configure("TFrame", background="#2d2d2d")
        self.style.configure("TButton", background="#3d3d3d", foreground="#ffffff")
        self.style.configure("TLabel", background="#2d2d2d", foreground="#ffffff")
        self.style.configure("TProgressbar", troughcolor="#2d2d2d", background="#007acc")
        self.style.configure("TCheckbutton", background="#2d2d2d", foreground="#ffffff")
        self.style.map("TCheckbutton", background=[("active", "#3d3d3d")])
        
        # Variables
        self.folder_paths = []  # List of selected folders
        self.include_subfolders = BooleanVar(value=True)  # Default to include subfolders
        self.is_running = False
        self.stop_requested = False
        self.renamed_count = 0
        self.skipped_count = 0
        self.error_count = 0
        self.processed_count = 0
        self.total_files = 0
        
        # Database path (shared across threads)
        self.db_path = os.path.join(os.path.expanduser("~"), "image_renamer.db")
        
        # Initialize database schema
        self.init_database()
        
        # Create UI
        self.create_widgets()
        
    def get_db_connection(self):
        """Get a thread-local database connection"""
        if not hasattr(thread_local, "conn"):
            thread_local.conn = sqlite3.connect(self.db_path)
            thread_local.cursor = thread_local.conn.cursor()
        return thread_local.conn, thread_local.cursor
    
    def init_database(self):
        """Initialize SQLite database to track renamed files"""
        conn, cursor = self.get_db_connection()
        
        # Create table if it doesn't exist
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS renamed_files (
                original_path TEXT PRIMARY KEY,
                new_name TEXT,
                renamed_on TIMESTAMP,
                status TEXT
            )
        ''')
        # Add index for faster lookups
        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_new_name ON renamed_files(new_name)
        ''')
        conn.commit()
    
    def create_widgets(self):
        """Create the GUI elements"""
        main_frame = ttk.Frame(self.root)
        main_frame.pack(fill=BOTH, expand=True, padx=20, pady=20)
        
        # Folder selection
        folder_frame = ttk.Frame(main_frame)
        folder_frame.pack(fill=X, pady=10)
        
        ttk.Label(folder_frame, text="Folders:").pack(side=TOP, anchor=W, padx=5)
        
        # Folder list with scrollbar
        folder_list_frame = ttk.Frame(folder_frame)
        folder_list_frame.pack(fill=X, expand=True, pady=5)
        
        # Create scrollable folder listbox with dark mode colors
        self.folder_listbox = Listbox(folder_list_frame, bg="#3d3d3d", fg="#ffffff", 
                                     selectbackground="#007acc", height=5)
        self.folder_listbox.pack(side=LEFT, fill=X, expand=True)
        
        folder_scrollbar = ttk.Scrollbar(folder_list_frame, command=self.folder_listbox.yview)
        folder_scrollbar.pack(side=RIGHT, fill=Y)
        self.folder_listbox.config(yscrollcommand=folder_scrollbar.set)
        
        # Folder buttons frame
        folder_buttons_frame = ttk.Frame(folder_frame)
        folder_buttons_frame.pack(fill=X, pady=5)
        
        ttk.Button(folder_buttons_frame, text="Add Folder", command=self.add_folder).pack(side=LEFT, padx=5)
        ttk.Button(folder_buttons_frame, text="Remove Selected", command=self.remove_folder).pack(side=LEFT, padx=5)
        
        # Subfolder option and thread info
        subfolder_frame = ttk.Frame(main_frame)
        subfolder_frame.pack(fill=X, pady=5)
        
        self.subfolder_check = ttk.Checkbutton(
            subfolder_frame, 
            text="Include subfolders", 
            variable=self.include_subfolders,
            style="TCheckbutton"
        )
        self.subfolder_check.pack(side=LEFT, padx=5)
        
        # Thread count display
        ttk.Label(subfolder_frame, text=f"Using {self.num_workers} worker threads").pack(side=RIGHT, padx=5)
        
        # Control buttons
        button_frame = ttk.Frame(main_frame)
        button_frame.pack(fill=X, pady=10)
        
        self.start_button = ttk.Button(button_frame, text="Start", command=self.start_renaming)
        self.start_button.pack(side=LEFT, padx=5)
        
        self.stop_button = ttk.Button(button_frame, text="Stop", command=self.stop_renaming, state=DISABLED)
        self.stop_button.pack(side=LEFT, padx=5)
        
        # Progress bar
        progress_frame = ttk.Frame(main_frame)
        progress_frame.pack(fill=X, pady=10)
        
        ttk.Label(progress_frame, text="Progress:").pack(side=LEFT, padx=5)
        self.progress_bar = ttk.Progressbar(progress_frame, orient=HORIZONTAL, length=100, mode='determinate')
        self.progress_bar.pack(side=LEFT, padx=5, fill=X, expand=True)
        
        self.progress_label = ttk.Label(progress_frame, text="0%")
        self.progress_label.pack(side=LEFT, padx=5)
        
        # Log display
        log_frame = ttk.Frame(main_frame)
        log_frame.pack(fill=BOTH, expand=True, pady=10)
        
        ttk.Label(log_frame, text="Log:").pack(anchor=W)
        
        # Create scrollable text widget with dark mode colors
        self.log_text = Text(log_frame, height=15, bg="#3d3d3d", fg="#ffffff", 
                           insertbackground="#ffffff", relief=SUNKEN)
        self.log_text.pack(side=LEFT, fill=BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(log_frame, command=self.log_text.yview)
        scrollbar.pack(side=RIGHT, fill=Y)
        self.log_text.config(yscrollcommand=scrollbar.set)
        
        # Statistics
        stats_frame = ttk.Frame(main_frame)
        stats_frame.pack(fill=X, pady=10)
        
        self.stats_label = ttk.Label(stats_frame, text="Ready")
        self.stats_label.pack(anchor=W)
    
    def add_folder(self):
        """Open folder browser dialog and add to the list"""
        folder_selected = filedialog.askdirectory()
        if folder_selected and folder_selected not in self.folder_paths:
            self.folder_paths.append(folder_selected)
            self.folder_listbox.insert(END, folder_selected)
            self.log(f"Added folder: {folder_selected}")
    
    def remove_folder(self):
        """Remove the selected folder from the list"""
        try:
            selection = self.folder_listbox.curselection()
            if selection:
                index = selection[0]
                folder = self.folder_paths[index]
                del self.folder_paths[index]
                self.folder_listbox.delete(index)
                self.log(f"Removed folder: {folder}")
        except Exception as e:
            self.log(f"Error removing folder: {str(e)}")
    
    def start_renaming(self):
        """Start the renaming process in a separate thread"""
        if not self.folder_paths:
            messagebox.showerror("Error", "Please add at least one folder first!")
            return
        
        self.is_running = True
        self.stop_requested = False
        self.start_button.config(state=DISABLED)
        self.stop_button.config(state=NORMAL)
        
        # Reset counters
        self.renamed_count = 0
        self.skipped_count = 0
        self.error_count = 0
        self.processed_count = 0
        
        # Start processing in a thread to keep UI responsive
        self.worker_thread = threading.Thread(target=self.rename_images)
        self.worker_thread.daemon = True
        self.worker_thread.start()
    
    def stop_renaming(self):
        """Request the renaming process to stop"""
        self.stop_requested = True
        self.log("Stop requested. Waiting for workers to finish current tasks...")
        self.stop_button.config(state=DISABLED)
    
    def log(self, message):
        """Add a message to the log with timestamp"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.root.after(0, lambda: self.log_text.insert(END, f"[{timestamp}] {message}\n"))
        self.root.after(0, lambda: self.log_text.see(END))  # Scroll to the end
    
    def is_image_file(self, file_path):
        """Check if a file is a valid image"""
        try:
            with Image.open(file_path) as img:
                return True
        except:
            return False
    
    def get_unused_number(self):
        """Generate a unique 10-digit number not already in the database"""
        conn, cursor = self.get_db_connection()
        with self.db_lock:
            while True:
                num = random.randint(1000000000, 9999999999)
                cursor.execute("SELECT COUNT(*) FROM renamed_files WHERE new_name=?", (str(num),))
                if cursor.fetchone()[0] == 0:
                    return num
    
    def get_all_files(self):
        """Get all files from selected folders based on subfolder option"""
        all_files = []
        include_subfolders = self.include_subfolders.get()
        
        for folder_path in self.folder_paths:
            if include_subfolders:
                # Include all files in folder and subfolders
                for root, _, files in os.walk(folder_path):
                    for file in files:
                        file_path = os.path.join(root, file)
                        all_files.append(file_path)
            else:
                # Include only files in the top-level folder
                for file in os.listdir(folder_path):
                    file_path = os.path.join(folder_path, file)
                    if os.path.isfile(file_path):
                        all_files.append(file_path)
        
        return all_files
    
    def process_file(self, file_path):
        """Process a single file - this function will be called by worker threads"""
        if self.stop_requested:
            return None, None, None, None
        
        try:
            conn, cursor = self.get_db_connection()
            file_path_obj = Path(file_path)
            
            # Check if the file already has a 10-digit numerical name
            filename_without_ext = file_path_obj.stem
            if filename_without_ext.isdigit() and len(filename_without_ext) == 10:
                # Skip files that already have 10-digit numerical names
                return None, 1, 0, 0  # Skipped, not renamed, no error
            
            # Check if this file has already been processed
            with self.db_lock:
                cursor.execute("SELECT new_name, status FROM renamed_files WHERE original_path=?", (file_path,))
                result = cursor.fetchone()
            
            if result:
                new_name, status = result
                if status == "renamed":
                    return None, 1, 0, 0  # Skipped, not renamed, no error
            
            # Check if it's an image file
            if not self.is_image_file(file_path):
                return None, 1, 0, 0  # Skipped, not renamed, no error
            
            # Generate a new unique name
            new_number = self.get_unused_number()
            file_extension = file_path_obj.suffix.lower()
            new_name = f"{new_number}{file_extension}"
            new_path = os.path.join(file_path_obj.parent, new_name)
            
            # Rename the file
            os.rename(file_path, new_path)
            
            # Update database
            now = datetime.now().isoformat()
            with self.db_lock:
                if result:
                    cursor.execute(
                        "UPDATE renamed_files SET new_name=?, renamed_on=?, status=? WHERE original_path=?",
                        (new_name, now, "renamed", file_path)
                    )
                else:
                    cursor.execute(
                        "INSERT INTO renamed_files (original_path, new_name, renamed_on, status) VALUES (?, ?, ?, ?)",
                        (file_path, new_name, now, "renamed")
                    )
                conn.commit()
            
            # Log occasional updates (to avoid log flooding)
            if random.random() < 0.01:  # Log about 1% of renames
                self.log(f"Renamed: {file_path_obj.name} -> {new_name}")
            
            return new_name, 0, 1, 0  # Not skipped, renamed, no error
            
        except Exception as e:
            self.log(f"Error processing {file_path}: {str(e)}")
            return None, 0, 0, 1  # Not skipped, not renamed, error
    
    def update_progress(self):
        """Update progress bar and stats - called periodically from main thread"""
        if not self.is_running:
            return
        
        # Update counters atomically
        processed = self.processed_count
        renamed = self.renamed_count
        skipped = self.skipped_count
        errors = self.error_count
        
        if self.total_files > 0:
            progress_percent = int((processed / self.total_files) * 100)
            self.progress_bar.config(value=progress_percent)
            self.progress_label.config(text=f"{progress_percent}%")
        
        # Update stats display
        stats_text = f"Processed: {processed}/{self.total_files} | Renamed: {renamed} | Skipped: {skipped} | Errors: {errors}"
        self.stats_label.config(text=stats_text)
        
        # Schedule the next update
        if self.is_running:
            self.root.after(100, self.update_progress)
    
    def rename_images(self):
        """Main function to rename all images in the selected folders using parallel processing"""
        try:
            self.log(f"Starting to scan selected folders with {self.num_workers} workers")
            self.log(f"Include subfolders: {'Yes' if self.include_subfolders.get() else 'No'}")
            
            # Get all files from selected folders
            all_files = self.get_all_files()
            self.total_files = len(all_files)
            self.log(f"Found {self.total_files} files in total")
            
            # Start progress updates
            self.root.after(0, self.update_progress)
            
            # Process files in parallel
            with concurrent.futures.ThreadPoolExecutor(max_workers=self.num_workers) as executor:
                # Submit all tasks
                future_to_file = {executor.submit(self.process_file, file): file for file in all_files}
                
                # Process results as they complete
                for future in concurrent.futures.as_completed(future_to_file):
                    if self.stop_requested:
                        executor.shutdown(wait=False)
                        break
                    
                    file = future_to_file[future]
                    try:
                        new_name, skipped, renamed, error = future.result()
                        
                        # Update counters
                        self.processed_count += 1
                        self.skipped_count += skipped
                        self.renamed_count += renamed
                        self.error_count += error
                        
                    except Exception as e:
                        self.log(f"Exception while processing {file}: {str(e)}")
                        self.error_count += 1
                        self.processed_count += 1
            
            # Complete the progress bar
            self.root.after(0, lambda: self.progress_bar.config(value=100))
            self.root.after(0, lambda: self.progress_label.config(text="100%"))
            
            # Show completion message
            completion_message = f"Process completed! Renamed: {self.renamed_count} | Skipped: {self.skipped_count} | Errors: {self.error_count}"
            self.log(completion_message)
            self.root.after(0, lambda: self.stats_label.config(text=completion_message))
            
            # Show completion dialog
            self.root.after(0, lambda: messagebox.showinfo("Complete", completion_message))
        
        except Exception as e:
            self.log(f"Error in renaming process: {str(e)}")
            self.root.after(0, lambda: messagebox.showerror("Error", f"An error occurred: {str(e)}"))
        
        finally:
            # Reset UI state
            self.is_running = False
            self.root.after(0, lambda: self.start_button.config(state=NORMAL))
            self.root.after(0, lambda: self.stop_button.config(state=DISABLED))

def main():
    root = Tk()
    app = ImageRenamer(root)
    root.mainloop()

if __name__ == "__main__":
    main()
