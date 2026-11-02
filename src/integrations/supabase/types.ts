export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          address: string | null
          company_name: string
          id: number
          invoice_footer: string | null
          logo_url: string | null
          phone: string | null
          tagline: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          company_name?: string
          id?: number
          invoice_footer?: string | null
          logo_url?: string | null
          phone?: string | null
          tagline?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          company_name?: string
          id?: number
          invoice_footer?: string | null
          logo_url?: string | null
          phone?: string | null
          tagline?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      attendance: {
        Row: {
          branch_id: string
          check_in: string | null
          check_out: string | null
          day: string
          employee_id: string
          id: string
          note: string | null
          status: string
        }
        Insert: {
          branch_id: string
          check_in?: string | null
          check_out?: string | null
          day?: string
          employee_id: string
          id?: string
          note?: string | null
          status?: string
        }
        Update: {
          branch_id?: string
          check_in?: string | null
          check_out?: string | null
          day?: string
          employee_id?: string
          id?: string
          note?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          details: Json | null
          id: string
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          details?: Json | null
          id?: string
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          details?: Json | null
          id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      branches: {
        Row: {
          active: boolean
          address: string | null
          brand: string | null
          code: string
          created_at: string
          expense_limit: number
          id: string
          is_dealer_house: boolean
          max_discount_pct: number
          name: string
          phone: string | null
        }
        Insert: {
          active?: boolean
          address?: string | null
          brand?: string | null
          code: string
          created_at?: string
          expense_limit?: number
          id?: string
          is_dealer_house?: boolean
          max_discount_pct?: number
          name: string
          phone?: string | null
        }
        Update: {
          active?: boolean
          address?: string | null
          brand?: string | null
          code?: string
          created_at?: string
          expense_limit?: number
          id?: string
          is_dealer_house?: boolean
          max_discount_pct?: number
          name?: string
          phone?: string | null
        }
        Relationships: []
      }
      customers: {
        Row: {
          address: string | null
          branch_id: string
          created_at: string
          id: string
          name: string
          nid: string | null
          phone: string
        }
        Insert: {
          address?: string | null
          branch_id: string
          created_at?: string
          id?: string
          name: string
          nid?: string | null
          phone: string
        }
        Update: {
          address?: string | null
          branch_id?: string
          created_at?: string
          id?: string
          name?: string
          nid?: string | null
          phone?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          active: boolean
          branch_id: string
          created_at: string
          designation: string | null
          id: string
          joined_on: string | null
          name: string
          phone: string | null
          salary: number
        }
        Insert: {
          active?: boolean
          branch_id: string
          created_at?: string
          designation?: string | null
          id?: string
          joined_on?: string | null
          name: string
          phone?: string | null
          salary?: number
        }
        Update: {
          active?: boolean
          branch_id?: string
          created_at?: string
          designation?: string | null
          id?: string
          joined_on?: string | null
          name?: string
          phone?: string | null
          salary?: number
        }
        Relationships: [
          {
            foreignKeyName: "employees_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          approved_by: string | null
          attachment_url: string | null
          branch_id: string
          category: string
          created_at: string
          created_by: string | null
          expense_date: string
          id: string
          method: string
          note: string | null
          status: string
        }
        Insert: {
          amount: number
          approved_by?: string | null
          attachment_url?: string | null
          branch_id: string
          category: string
          created_at?: string
          created_by?: string | null
          expense_date?: string
          id?: string
          method?: string
          note?: string | null
          status?: string
        }
        Update: {
          amount?: number
          approved_by?: string | null
          attachment_url?: string | null
          branch_id?: string
          category?: string
          created_at?: string
          created_by?: string | null
          expense_date?: string
          id?: string
          method?: string
          note?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "expenses_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_cases: {
        Row: {
          amount: number
          branch_id: string
          commission: number
          created_at: string
          created_by: string | null
          customer_name: string
          customer_phone: string | null
          id: string
          note: string | null
          partner_id: string
          ref_no: string | null
          sale_id: string | null
          settled_at: string | null
          status: string
        }
        Insert: {
          amount: number
          branch_id: string
          commission?: number
          created_at?: string
          created_by?: string | null
          customer_name: string
          customer_phone?: string | null
          id?: string
          note?: string | null
          partner_id: string
          ref_no?: string | null
          sale_id?: string | null
          settled_at?: string | null
          status?: string
        }
        Update: {
          amount?: number
          branch_id?: string
          commission?: number
          created_at?: string
          created_by?: string | null
          customer_name?: string
          customer_phone?: string | null
          id?: string
          note?: string | null
          partner_id?: string
          ref_no?: string | null
          sale_id?: string | null
          settled_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_cases_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_cases_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "finance_partners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_cases_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_partner_ledger: {
        Row: {
          amount: number
          branch_id: string
          case_id: string | null
          created_at: string
          created_by: string | null
          id: string
          kind: string
          method: string
          note: string | null
          partner_id: string
        }
        Insert: {
          amount: number
          branch_id: string
          case_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
          method?: string
          note?: string | null
          partner_id: string
        }
        Update: {
          amount?: number
          branch_id?: string
          case_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          method?: string
          note?: string | null
          partner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_partner_ledger_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_partner_ledger_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "finance_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_partner_ledger_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "finance_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_partners: {
        Row: {
          active: boolean
          commission_pct: number
          contact: string | null
          created_at: string
          id: string
          name: string
        }
        Insert: {
          active?: boolean
          commission_pct?: number
          contact?: string | null
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          active?: boolean
          commission_pct?: number
          contact?: string | null
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      installment_plans: {
        Row: {
          branch_id: string
          created_at: string
          customer_id: string
          down_payment: number
          financed_amount: number
          id: string
          monthly_amount: number
          months: number
          sale_id: string
          status: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          customer_id: string
          down_payment?: number
          financed_amount: number
          id?: string
          monthly_amount: number
          months: number
          sale_id: string
          status?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          customer_id?: string
          down_payment?: number
          financed_amount?: number
          id?: string
          monthly_amount?: number
          months?: number
          sale_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "installment_plans_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installment_plans_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installment_plans_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
        ]
      }
      installments: {
        Row: {
          amount: number
          branch_id: string
          cancelled: boolean
          due_date: string
          id: string
          paid_amount: number
          paid_at: string | null
          plan_id: string
          seq: number
        }
        Insert: {
          amount: number
          branch_id: string
          cancelled?: boolean
          due_date: string
          id?: string
          paid_amount?: number
          paid_at?: string | null
          plan_id: string
          seq: number
        }
        Update: {
          amount?: number
          branch_id?: string
          cancelled?: boolean
          due_date?: string
          id?: string
          paid_amount?: number
          paid_at?: string | null
          plan_id?: string
          seq?: number
        }
        Relationships: [
          {
            foreignKeyName: "installments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installments_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "installment_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          branch_id: string
          created_at: string
          id: string
          imei: string
          imei2: string | null
          product_id: string
          purchase_price: number
          status: string
          supplier: string | null
        }
        Insert: {
          branch_id: string
          created_at?: string
          id?: string
          imei: string
          imei2?: string | null
          product_id: string
          purchase_price?: number
          status?: string
          supplier?: string | null
        }
        Update: {
          branch_id?: string
          created_at?: string
          id?: string
          imei?: string
          imei2?: string | null
          product_id?: string
          purchase_price?: number
          status?: string
          supplier?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      offline_ops: {
        Row: {
          branch_id: string | null
          client_ref: string
          device: string | null
          error: string | null
          kind: string
          payload: Json
          queued_at: string
          resolved: boolean
          resolved_by: string | null
          result: Json | null
          status: string
          synced_at: string
          user_id: string
        }
        Insert: {
          branch_id?: string | null
          client_ref: string
          device?: string | null
          error?: string | null
          kind: string
          payload: Json
          queued_at: string
          resolved?: boolean
          resolved_by?: string | null
          result?: Json | null
          status: string
          synced_at?: string
          user_id?: string
        }
        Update: {
          branch_id?: string | null
          client_ref?: string
          device?: string | null
          error?: string | null
          kind?: string
          payload?: Json
          queued_at?: string
          resolved?: boolean
          resolved_by?: string | null
          result?: Json | null
          status?: string
          synced_at?: string
          user_id?: string
        }
        Relationships: []
      }
      products: {
        Row: {
          brand: string
          created_at: string
          id: string
          kind: string
          model: string
          purchase_price: number
          sale_price: number
          variant: string | null
        }
        Insert: {
          brand: string
          created_at?: string
          id?: string
          kind?: string
          model: string
          purchase_price?: number
          sale_price?: number
          variant?: string | null
        }
        Update: {
          brand?: string
          created_at?: string
          id?: string
          kind?: string
          model?: string
          purchase_price?: number
          sale_price?: number
          variant?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          branch_id: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          print_lang: string
        }
        Insert: {
          branch_id?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          print_lang?: string
        }
        Update: {
          branch_id?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          print_lang?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_items: {
        Row: {
          cost: number
          id: string
          item_id: string
          purchase_id: string
          returned: boolean
        }
        Insert: {
          cost: number
          id?: string
          item_id: string
          purchase_id: string
          returned?: boolean
        }
        Update: {
          cost?: number
          id?: string
          item_id?: string
          purchase_id?: string
          returned?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "purchase_items_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_items_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_payments: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          id: string
          method: string
          purchase_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          id?: string
          method?: string
          purchase_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          id?: string
          method?: string
          purchase_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_payments_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
        ]
      }
      purchases: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          paid: number
          returned: number
          seq_no: number | null
          supplier_id: string
          supplier_invoice: string | null
          total: number
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          paid?: number
          returned?: number
          seq_no?: number | null
          supplier_id: string
          supplier_invoice?: string | null
          total?: number
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          paid?: number
          returned?: number
          seq_no?: number | null
          supplier_id?: string
          supplier_invoice?: string | null
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchases_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchases_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      sale_items: {
        Row: {
          id: string
          item_id: string
          price: number
          sale_id: string
        }
        Insert: {
          id?: string
          item_id: string
          price: number
          sale_id: string
        }
        Update: {
          id?: string
          item_id?: string
          price?: number
          sale_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sale_items_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_items_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
        ]
      }
      sales: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          customer_id: string | null
          discount: number
          discount_approved_by: string | null
          discount_reason: string | null
          id: string
          invoice_no: string
          paid: number
          payment_method: string
          return_reason: string | null
          returned_at: string | null
          sale_type: string
          seq_no: number | null
          status: string
          subtotal: number
          total: number
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          discount?: number
          discount_approved_by?: string | null
          discount_reason?: string | null
          id?: string
          invoice_no?: string
          paid?: number
          payment_method?: string
          return_reason?: string | null
          returned_at?: string | null
          sale_type?: string
          seq_no?: number | null
          status?: string
          subtotal?: number
          total?: number
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          discount?: number
          discount_approved_by?: string | null
          discount_reason?: string | null
          id?: string
          invoice_no?: string
          paid?: number
          payment_method?: string
          return_reason?: string | null
          returned_at?: string | null
          sale_type?: string
          seq_no?: number | null
          status?: string
          subtotal?: number
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "sales_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_transfers: {
        Row: {
          created_at: string
          created_by: string | null
          from_branch_id: string
          id: string
          note: string | null
          received_at: string | null
          received_by: string | null
          status: string
          to_branch_id: string
          transfer_no: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          from_branch_id: string
          id?: string
          note?: string | null
          received_at?: string | null
          received_by?: string | null
          status?: string
          to_branch_id: string
          transfer_no?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          from_branch_id?: string
          id?: string
          note?: string | null
          received_at?: string | null
          received_by?: string | null
          status?: string
          to_branch_id?: string
          transfer_no?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_transfers_from_branch_id_fkey"
            columns: ["from_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_to_branch_id_fkey"
            columns: ["to_branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          address: string | null
          created_at: string
          id: string
          name: string
          phone: string | null
        }
        Insert: {
          address?: string | null
          created_at?: string
          id?: string
          name: string
          phone?: string | null
        }
        Update: {
          address?: string | null
          created_at?: string
          id?: string
          name?: string
          phone?: string | null
        }
        Relationships: []
      }
      transactions: {
        Row: {
          amount: number
          branch_id: string
          category: string
          created_at: string
          created_by: string | null
          id: string
          kind: string
          note: string | null
          ref_id: string | null
        }
        Insert: {
          amount: number
          branch_id: string
          category: string
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
          note?: string | null
          ref_id?: string | null
        }
        Update: {
          amount?: number
          branch_id?: string
          category?: string
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          note?: string | null
          ref_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "transactions_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      transfer_items: {
        Row: {
          id: string
          item_id: string
          transfer_id: string
        }
        Insert: {
          id?: string
          item_id: string
          transfer_id: string
        }
        Update: {
          id?: string
          item_id?: string
          transfer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transfer_items_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_items_transfer_id_fkey"
            columns: ["transfer_id"]
            isOneToOne: false
            referencedRelation: "stock_transfers"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_set_user: {
        Args: {
          _branch: string
          _role: Database["public"]["Enums"]["app_role"]
          _user: string
        }
        Returns: undefined
      }
      apply_offline_op: {
        Args: {
          _client_ref: string
          _device: string
          _kind: string
          _payload: Json
          _queued_at: string
        }
        Returns: Json
      }
      can_access_branch: {
        Args: { _branch: string; _uid: string }
        Returns: boolean
      }
      can_approve_branch: {
        Args: { _branch: string; _uid: string }
        Returns: boolean
      }
      can_operate_branch: {
        Args: { _branch: string; _uid: string }
        Returns: boolean
      }
      can_write_hq: { Args: { _uid: string }; Returns: boolean }
      create_purchase: {
        Args: {
          _branch: string
          _invoice: string
          _items: Json
          _method: string
          _note: string
          _paid: number
          _supplier: string
        }
        Returns: string
      }
      create_sale: {
        Args: {
          _branch: string
          _customer: string
          _discount: number
          _discount_reason?: string
          _items: Json
          _method: string
          _months: number
          _paid: number
          _sale_type: string
        }
        Returns: string
      }
      create_transfer: {
        Args: { _from: string; _item_ids: string[]; _note: string; _to: string }
        Returns: string
      }
      decide_expense: {
        Args: { _approve: boolean; _expense: string }
        Returns: undefined
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_hq: { Args: { _uid: string }; Returns: boolean }
      partner_payment: {
        Args: {
          _amount: number
          _branch: string
          _kind: string
          _method: string
          _note: string
          _partner: string
        }
        Returns: undefined
      }
      pay_installment: {
        Args: { _amount: number; _inst: string }
        Returns: undefined
      }
      pay_supplier: {
        Args: { _amount: number; _method: string; _purchase: string }
        Returns: undefined
      }
      receive_transfer: { Args: { _transfer: string }; Returns: undefined }
      return_purchase_item: {
        Args: { _purchase_item: string }
        Returns: undefined
      }
      return_sale: {
        Args: { _reason: string; _sale: string }
        Returns: undefined
      }
      settle_finance: {
        Args: { _case: string; _received: number }
        Returns: undefined
      }
      submit_expense: {
        Args: {
          _amount: number
          _attachment: string
          _branch: string
          _category: string
          _date: string
          _method: string
          _note: string
        }
        Returns: string
      }
      user_branch: { Args: { _uid: string }; Returns: string }
    }
    Enums: {
      app_role:
        | "super_admin"
        | "dealer_admin"
        | "branch_manager"
        | "sales"
        | "accountant"
        | "auditor"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "super_admin",
        "dealer_admin",
        "branch_manager",
        "sales",
        "accountant",
        "auditor",
      ],
    },
  },
} as const
